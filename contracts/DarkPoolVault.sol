// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";
import {INoxCompute} from "@iexec-nox/nox-protocol-contracts/contracts/interfaces/INoxCompute.sol";
import {TEEType} from "@iexec-nox/nox-protocol-contracts/contracts/utils/TypeUtils.sol";
import {ConfidentialToken} from "./ConfidentialToken.sol";

/**
 * @title DarkPoolVault (v3.2 — confidentialité de bout en bout + flux furtifs)
 * @dev Garde des fonds et règlement confidentiel des ordres appariés par l'enclave iExec Nox.
 *
 *      Contrairement à la v2, TOUT l'état interne est chiffré (euint256) :
 *      - les soldes (disponibles et séquestrés) ne sont jamais visibles on-chain ;
 *      - la solvabilité est vérifiée SUR CHIFFRÉS à la soumission (Nox.le + Nox.select),
 *        sans jamais révéler ni le montant de l'ordre ni le solde ;
 *      - le règlement échange les montants séquestrés chiffrés (Nox.add/Nox.sub) :
 *        MatchSettled ne publie AUCUN montant.
 *
 *      v3.2 (P0.3) : dépôts/retraits 100% confidentiels en tokens confidentiels Nox
 *      (ConfidentialToken, ex: cWETH/cUSDC) — le montant déposé/retiré est un handle
 *      chiffré, plus aucun flux n'apparaît en clair sur Etherscan. Le retrait
 *      confidentiel est SYNCHRONE (pas de file, pas d'enclave) : la couverture est
 *      vérifiée sur chiffrés (Nox.le + Nox.select).
 *
 *      v3.2 (P0.4) : variantes meta-transaction (*For) relayables — une adresse
 *      furtive signe hors-chaîne, un relayer paie le gas. Le wallet principal de
 *      l'utilisateur n'apparaît jamais côté trading et l'adresse furtive n'a jamais
 *      besoin d'ETH. Les preuves de handles sont validées contre l'owner déclaré
 *      (et non msg.sender), le proof Nox encodant lui-même son créateur.
 *
 *      Seuls le dépôt et le retrait en ERC-20 *nus* (héritage v3.1) manipulent des
 *      montants publics.
 */
contract DarkPoolVault is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    address public enclaveAddress;
    uint256 public nextOrderId;

    struct Order {
        address owner;
        address tokenIn;
        address tokenOut;
        euint256 amountIn;
        euint256 minAmountOut;
        // select(solvencyOk, amountIn, 0) : montant séquestré à la soumission.
        // Vaut 0 chiffré si le solde était insuffisant — l'ordre est alors inerte.
        euint256 lockedAmount;
        ebool solvencyOk;
        bool isSettled;
    }

    struct MatchRef {
        uint256 orderId1;
        uint256 orderId2;
        externalEuint256 amount1To2External;
        bytes amount1To2Proof;
        externalEuint256 amount2To1External;
        bytes amount2To1Proof;
        bool closeOrder1;
        bool closeOrder2;
        uint256 salt; // Nonce unique généré par l'enclave pour empêcher le rejeu du match
    }

    // Soldes internes chiffrés : utilisateur => token => handle euint256
    mapping(address => mapping(address => euint256)) private _available;
    mapping(address => mapping(address => euint256)) private _locked;

    // File de retraits : garantit qu'une demande ne peut être exécutée qu'UNE fois,
    // même si plusieurs enclaves (ou un redémarrage re-scannant les blocs) la traitent.
    mapping(address => mapping(address => uint256)) public pendingWithdrawals;

    mapping(uint256 => Order) public orders;
    mapping(bytes32 => bool) public processedMatches;

    // Nonces des meta-transactions relayées (P0.4) — anti-rejeu par utilisateur
    mapping(address => uint256) public metaNonces;

    event Deposit(address indexed user, address indexed token, uint256 amount);
    // Aucun montant : dépôt/retrait en token confidentiel (P0.3)
    event ConfidentialDeposit(address indexed user, address indexed token);
    event ConfidentialWithdrawal(address indexed user, address indexed token);
    event WithdrawRequested(address indexed user, address indexed token, uint256 amount);
    event WithdrawRejected(address indexed user, address indexed token, uint256 amount);
    event Withdrawal(address indexed user, address indexed token, uint256 amount);
    event OrderSubmitted(
        uint256 indexed orderId,
        address indexed owner,
        address tokenIn,
        address tokenOut,
        bytes32 amountInHandle,
        bytes32 minAmountOutHandle,
        bytes32 solvencyOkHandle
    );
    event OrderCancelled(uint256 indexed orderId, address indexed owner);
    // Aucun montant : le règlement est entièrement confidentiel
    event MatchSettled(
        uint256 indexed orderId1,
        uint256 indexed orderId2,
        address user1,
        address user2,
        address token1,
        address token2
    );
    event EnclaveAddressUpdated(address indexed oldAddress, address indexed newAddress);

    constructor(address _enclaveAddress) Ownable(msg.sender) {
        require(_enclaveAddress != address(0), "DarkPoolVault: Invalid enclave address");
        enclaveAddress = _enclaveAddress;
    }

    modifier onlyEnclave() {
        require(msg.sender == enclaveAddress, "DarkPoolVault: Not enclave");
        _;
    }

    function updateEnclaveAddress(address _newEnclaveAddress) external onlyOwner {
        require(_newEnclaveAddress != address(0), "DarkPoolVault: Invalid address");
        emit EnclaveAddressUpdated(enclaveAddress, _newEnclaveAddress);
        enclaveAddress = _newEnclaveAddress;
    }

    // ============ Soldes chiffrés (lecture des handles) ============

    function availableBalanceOf(address user, address token) external view returns (bytes32) {
        return euint256.unwrap(_available[user][token]);
    }

    function lockedBalanceOf(address user, address token) external view returns (bytes32) {
        return euint256.unwrap(_locked[user][token]);
    }

    /**
     * @dev Chaque opération Nox produit un NOUVEAU handle : il faut re-déclarer à
     *      chaque fois qui a le droit de l'utiliser (le contrat pour les calculs
     *      futurs, l'utilisateur et l'enclave pour le déchiffrement KMS).
     */
    function _grantBalanceACL(euint256 handle, address user) private {
        Nox.allowThis(handle);
        Nox.allow(handle, user);
        Nox.allow(handle, enclaveAddress);
    }

    // ============ Dépôt / Retrait ============

    /**
     * @dev Dépose des tokens ERC-20. Le montant déposé est public (transfert ERC-20),
     *      mais il est immédiatement fondu dans le solde chiffré.
     */
    function deposit(address token, uint256 amount) external nonReentrant {
        require(amount > 0, "DarkPoolVault: Amount must be greater than 0");
        euint256 newBal = Nox.add(_available[msg.sender][token], Nox.toEuint256(amount));
        _grantBalanceACL(newBal, msg.sender);
        _available[msg.sender][token] = newBal;
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit Deposit(msg.sender, token, amount);
    }

    /**
     * @dev Demande de retrait. Le contrat ne peut pas comparer un montant public à un
     *      solde chiffré de façon synchrone : l'enclave déchiffre le solde via le KMS,
     *      vérifie la couverture, puis appelle executeWithdraw().
     */
    function requestWithdraw(address token, uint256 amount) external {
        require(amount > 0, "DarkPoolVault: Amount must be greater than 0");
        require(pendingWithdrawals[msg.sender][token] == 0, "DarkPoolVault: Withdrawal already pending");
        pendingWithdrawals[msg.sender][token] = amount;
        emit WithdrawRequested(msg.sender, token, amount);
    }

    /**
     * @dev Annule sa propre demande en attente (si l'enclave est hors-ligne par exemple).
     */
    function cancelWithdrawRequest(address token) external {
        pendingWithdrawals[msg.sender][token] = 0;
    }

    /**
     * @dev Exécution du retrait, réservée à l'enclave après vérification du solde déchiffré.
     *      La demande est consommée : une double exécution (enclave dupliquée, re-scan
     *      après redémarrage) revert au lieu de payer deux fois.
     */
    function executeWithdraw(address user, address token, uint256 amount) external onlyEnclave nonReentrant {
        require(pendingWithdrawals[user][token] == amount, "DarkPoolVault: No matching pending request");
        pendingWithdrawals[user][token] = 0;
        euint256 newBal = Nox.sub(_available[user][token], Nox.toEuint256(amount));
        _grantBalanceACL(newBal, user);
        _available[user][token] = newBal;
        IERC20(token).safeTransfer(user, amount);
        emit Withdrawal(user, token, amount);
    }

    /**
     * @dev Rejet d'une demande (solde insuffisant) : libère le slot et notifie l'UI.
     */
    function rejectWithdraw(address user, address token) external onlyEnclave {
        uint256 amount = pendingWithdrawals[user][token];
        require(amount != 0, "DarkPoolVault: No pending request");
        pendingWithdrawals[user][token] = 0;
        emit WithdrawRejected(user, token, amount);
    }

    // ============ Dépôt / Retrait confidentiels (P0.3 — ConfidentialToken) ============

    /**
     * @dev Dépôt 100% confidentiel en token confidentiel Nox (cWETH/cUSDC) : le montant
     *      est un handle chiffré, le wrapper déplace le solde chiffré de l'utilisateur
     *      vers le vault (Nox.transfer atomique). Si le solde wrapper est insuffisant,
     *      0 est déposé — sans revert ni fuite. Prérequis : l'utilisateur a approuvé le
     *      vault comme opérateur du ConfidentialToken (setOperator / setOperatorWithSig).
     */
    function depositConfidential(
        address cToken,
        externalEuint256 amountExternal,
        bytes calldata amountProof
    ) external nonReentrant {
        euint256 amount = Nox.fromExternal(amountExternal, amountProof);
        _depositConfidential(msg.sender, cToken, amount);
    }

    /**
     * @dev Retrait 100% confidentiel et SYNCHRONE : la couverture est vérifiée sur
     *      chiffrés (le retrait vaut 0 si le solde disponible est insuffisant), puis
     *      le wrapper recrédite le solde chiffré de l'utilisateur. Aucune file
     *      d'attente, aucune intervention de l'enclave, aucun montant révélé.
     */
    function withdrawConfidential(
        address cToken,
        externalEuint256 amountExternal,
        bytes calldata amountProof
    ) external nonReentrant {
        euint256 amount = Nox.fromExternal(amountExternal, amountProof);
        _withdrawConfidential(msg.sender, cToken, amount);
    }

    function _depositConfidential(address user, address cToken, euint256 amount) private {
        // Le wrapper doit pouvoir lire le montant chiffré le temps de la transaction
        Nox.allowTransient(amount, cToken);
        euint256 transferred = ConfidentialToken(cToken).operatorTransfer(user, address(this), amount);
        euint256 newBal = Nox.add(_available[user][cToken], transferred);
        _grantBalanceACL(newBal, user);
        _available[user][cToken] = newBal;
        emit ConfidentialDeposit(user, cToken);
    }

    function _withdrawConfidential(address user, address cToken, euint256 amount) private {
        euint256 bal = _available[user][cToken];
        ebool ok = Nox.le(amount, bal);
        euint256 out = Nox.select(ok, amount, Nox.toEuint256(0));
        euint256 newBal = Nox.sub(bal, out);
        _grantBalanceACL(newBal, user);
        _available[user][cToken] = newBal;
        // `out` <= solde disponible de l'utilisateur <= solde wrapper du vault :
        // le Nox.transfer du wrapper réussit toujours.
        Nox.allowTransient(out, cToken);
        ConfidentialToken(cToken).operatorTransfer(address(this), user, out);
        emit ConfidentialWithdrawal(user, cToken);
    }

    // ============ Ordres ============

    /**
     * @dev Soumet un ordre confidentiel avec vérification de solvabilité SUR CHIFFRÉS :
     *      ok       = (amountIn <= soldeDisponible)        — comparaison chiffrée
     *      lockAmt  = ok ? amountIn : 0                     — sélection chiffrée
     *      disponible -= lockAmt ; séquestré += lockAmt     — arithmétique chiffrée
     *      Ni le montant, ni le solde, ni le résultat ne sont révélés on-chain.
     *      L'enclave déchiffre `ok` et ignore les ordres insolvables.
     */
    function submitOrder(
        address tokenIn,
        address tokenOut,
        externalEuint256 amountInExternal,
        bytes calldata amountInProof,
        externalEuint256 minAmountOutExternal,
        bytes calldata minAmountOutProof
    ) external returns (uint256) {
        euint256 amountIn = Nox.fromExternal(amountInExternal, amountInProof);
        euint256 minAmountOut = Nox.fromExternal(minAmountOutExternal, minAmountOutProof);
        return _submitOrder(msg.sender, tokenIn, tokenOut, amountIn, minAmountOut);
    }

    function _submitOrder(
        address owner_,
        address tokenIn,
        address tokenOut,
        euint256 amountIn,
        euint256 minAmountOut
    ) private returns (uint256) {
        require(tokenIn != tokenOut, "DarkPoolVault: Identical tokens");

        euint256 bal = _available[owner_][tokenIn];
        ebool ok = Nox.le(amountIn, bal);
        euint256 lockAmt = Nox.select(ok, amountIn, Nox.toEuint256(0));

        euint256 newAvail = Nox.sub(bal, lockAmt);
        euint256 newLocked = Nox.add(_locked[owner_][tokenIn], lockAmt);
        _grantBalanceACL(newAvail, owner_);
        _grantBalanceACL(newLocked, owner_);
        _available[owner_][tokenIn] = newAvail;
        _locked[owner_][tokenIn] = newLocked;

        // ACL : le contrat re-calculera sur ces handles (cancel/settle), l'enclave et
        // le propriétaire doivent pouvoir les déchiffrer via le KMS.
        Nox.allowThis(amountIn);
        Nox.allowThis(minAmountOut);
        Nox.allowThis(lockAmt);
        Nox.allow(amountIn, enclaveAddress);
        Nox.allow(minAmountOut, enclaveAddress);
        Nox.allow(ok, enclaveAddress);
        Nox.allow(amountIn, owner_);
        Nox.allow(minAmountOut, owner_);
        Nox.allow(ok, owner_);

        uint256 orderId = nextOrderId++;
        orders[orderId] = Order({
            owner: owner_,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            minAmountOut: minAmountOut,
            lockedAmount: lockAmt,
            solvencyOk: ok,
            isSettled: false
        });

        emit OrderSubmitted(
            orderId,
            owner_,
            tokenIn,
            tokenOut,
            euint256.unwrap(amountIn),
            euint256.unwrap(minAmountOut),
            ebool.unwrap(ok)
        );

        return orderId;
    }

    /**
     * @dev Annule un ordre en attente et déséquestre les fonds (0 chiffré si l'ordre
     *      était insolvable — l'opération reste valide).
     */
    function cancelOrder(uint256 orderId) external {
        Order storage o = orders[orderId];
        require(o.owner == msg.sender, "DarkPoolVault: Not order owner");
        require(!o.isSettled, "DarkPoolVault: Order already settled");
        o.isSettled = true;

        euint256 newLocked = Nox.sub(_locked[msg.sender][o.tokenIn], o.lockedAmount);
        euint256 newAvail = Nox.add(_available[msg.sender][o.tokenIn], o.lockedAmount);
        _grantBalanceACL(newLocked, msg.sender);
        _grantBalanceACL(newAvail, msg.sender);
        _locked[msg.sender][o.tokenIn] = newLocked;
        _available[msg.sender][o.tokenIn] = newAvail;

        emit OrderCancelled(orderId, msg.sender);
    }

    // ============ Meta-transactions relayées (P0.4 — client furtif) ============
    //
    // L'adresse furtive signe la requête hors-chaîne (EIP-191 sur un digest liant
    // chainid + vault + action + paramètres + nonce) ; n'importe quel relayer soumet
    // la transaction et paie le gas. L'adresse furtive n'a JAMAIS besoin d'ETH et le
    // wallet principal n'apparaît jamais on-chain côté trading.
    //
    // Les preuves de handles Nox sont validées contre l'owner déclaré (le proof encode
    // lui-même l'adresse de son créateur) et non contre msg.sender (le relayer).

    function submitOrderFor(
        address owner_,
        address tokenIn,
        address tokenOut,
        externalEuint256 amountInExternal,
        bytes calldata amountInProof,
        externalEuint256 minAmountOutExternal,
        bytes calldata minAmountOutProof,
        uint256 nonce,
        bytes calldata signature
    ) external returns (uint256) {
        bytes32 digest = keccak256(
            abi.encode(
                block.chainid,
                address(this),
                "submitOrder",
                owner_,
                tokenIn,
                tokenOut,
                externalEuint256.unwrap(amountInExternal),
                externalEuint256.unwrap(minAmountOutExternal),
                nonce
            )
        );
        _verifyMetaSig(owner_, nonce, digest, signature);
        euint256 amountIn = _fromExternalFor(amountInExternal, amountInProof, owner_);
        euint256 minAmountOut = _fromExternalFor(minAmountOutExternal, minAmountOutProof, owner_);
        return _submitOrder(owner_, tokenIn, tokenOut, amountIn, minAmountOut);
    }

    function depositConfidentialFor(
        address owner_,
        address cToken,
        externalEuint256 amountExternal,
        bytes calldata amountProof,
        uint256 nonce,
        bytes calldata signature
    ) external nonReentrant {
        bytes32 digest = keccak256(
            abi.encode(
                block.chainid,
                address(this),
                "depositConfidential",
                owner_,
                cToken,
                externalEuint256.unwrap(amountExternal),
                nonce
            )
        );
        _verifyMetaSig(owner_, nonce, digest, signature);
        euint256 amount = _fromExternalFor(amountExternal, amountProof, owner_);
        _depositConfidential(owner_, cToken, amount);
    }

    function withdrawConfidentialFor(
        address owner_,
        address cToken,
        externalEuint256 amountExternal,
        bytes calldata amountProof,
        uint256 nonce,
        bytes calldata signature
    ) external nonReentrant {
        bytes32 digest = keccak256(
            abi.encode(
                block.chainid,
                address(this),
                "withdrawConfidential",
                owner_,
                cToken,
                externalEuint256.unwrap(amountExternal),
                nonce
            )
        );
        _verifyMetaSig(owner_, nonce, digest, signature);
        euint256 amount = _fromExternalFor(amountExternal, amountProof, owner_);
        _withdrawConfidential(owner_, cToken, amount);
    }

    function _verifyMetaSig(address owner_, uint256 nonce, bytes32 digest, bytes calldata signature) private {
        require(nonce == metaNonces[owner_], "DarkPoolVault: Bad nonce");
        metaNonces[owner_] = nonce + 1;
        address signer = ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(digest), signature);
        require(signer == owner_, "DarkPoolVault: Invalid meta signature");
    }

    /**
     * @dev Équivalent de Nox.fromExternal mais la preuve est validée contre l'owner
     *      déclaré : le relayer (msg.sender) n'est qu'un transporteur.
     */
    function _fromExternalFor(
        externalEuint256 externalHandle,
        bytes calldata proof,
        address owner_
    ) private returns (euint256) {
        bytes32 handle = externalEuint256.unwrap(externalHandle);
        INoxCompute(Nox.noxComputeContract()).validateInputProof(handle, owner_, proof, TEEType.Uint256);
        return euint256.wrap(handle);
    }

    /**
     * @dev Règle des matches signés par l'enclave. L'enclave transmet les identifiants
     *      d'ordres, les montants d'exécution chiffrés avec leurs preuves associés,
     *      les indicateurs de clôture d'ordres, et un salt unique.
     */
    function settleMatches(MatchRef[] calldata matches, bytes calldata signature) external nonReentrant {
        bytes32 messageHash = keccak256(abi.encode(block.chainid, address(this), matches));
        bytes32 ethSignedMessageHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
        address signer = recoverSigner(ethSignedMessageHash, signature);
        require(signer == enclaveAddress, "DarkPoolVault: Invalid enclave signature");

        for (uint256 i = 0; i < matches.length; i++) {
            MatchRef calldata m = matches[i];

            bytes32 matchHash = keccak256(abi.encode(
                m.orderId1,
                m.orderId2,
                externalEuint256.unwrap(m.amount1To2External),
                externalEuint256.unwrap(m.amount2To1External),
                m.closeOrder1,
                m.closeOrder2,
                m.salt
            ));
            require(!processedMatches[matchHash], "DarkPoolVault: Match already processed");
            processedMatches[matchHash] = true;

            Order storage o1 = orders[m.orderId1];
            Order storage o2 = orders[m.orderId2];

            require(o1.owner != address(0) && o2.owner != address(0), "DarkPoolVault: Unknown order");
            require(!o1.isSettled, "DarkPoolVault: Order1 already settled");
            require(!o2.isSettled, "DarkPoolVault: Order2 already settled");
            require(
                o1.tokenIn == o2.tokenOut && o1.tokenOut == o2.tokenIn,
                "DarkPoolVault: Pair mismatch"
            );

            // Import des montants d'exécution chiffrés signés par l'enclave
            euint256 amount1To2 = _fromExternalFor(m.amount1To2External, m.amount1To2Proof, enclaveAddress);
            euint256 amount2To1 = _fromExternalFor(m.amount2To1External, m.amount2To1Proof, enclaveAddress);

            Nox.allowThis(amount1To2);
            Nox.allowThis(amount2To1);
            Nox.allow(amount1To2, o1.owner);
            Nox.allow(amount1To2, o2.owner);
            Nox.allow(amount1To2, enclaveAddress);
            Nox.allow(amount2To1, o1.owner);
            Nox.allow(amount2To1, o2.owner);
            Nox.allow(amount2To1, enclaveAddress);

            // Calcul du reste verrouillé dans chaque ordre
            euint256 newOrderLocked1 = Nox.sub(o1.lockedAmount, amount1To2);
            euint256 newOrderLocked2 = Nox.sub(o2.lockedAmount, amount2To1);

            Nox.allowThis(newOrderLocked1);
            Nox.allowThis(newOrderLocked2);
            Nox.allow(newOrderLocked1, o1.owner);
            Nox.allow(newOrderLocked1, enclaveAddress);
            Nox.allow(newOrderLocked2, o2.owner);
            Nox.allow(newOrderLocked2, enclaveAddress);

            // 1. Transfert du token1 (amount1To2) de o1.owner vers o2.owner
            euint256 newLocked1 = Nox.sub(_locked[o1.owner][o1.tokenIn], amount1To2);
            _grantBalanceACL(newLocked1, o1.owner);
            _locked[o1.owner][o1.tokenIn] = newLocked1;

            euint256 newAvail2 = Nox.add(_available[o2.owner][o1.tokenIn], amount1To2);
            _grantBalanceACL(newAvail2, o2.owner);
            _available[o2.owner][o1.tokenIn] = newAvail2;

            // 2. Transfert du token2 (amount2To1) de o2.owner vers o1.owner
            euint256 newLocked2 = Nox.sub(_locked[o2.owner][o2.tokenIn], amount2To1);
            _grantBalanceACL(newLocked2, o2.owner);
            _locked[o2.owner][o2.tokenIn] = newLocked2;

            euint256 newAvail1 = Nox.add(_available[o1.owner][o2.tokenIn], amount2To1);
            _grantBalanceACL(newAvail1, o1.owner);
            _available[o1.owner][o2.tokenIn] = newAvail1;

            // 3. Mise à jour du lockedAmount dans l'état de l'ordre
            o1.lockedAmount = newOrderLocked1;
            o2.lockedAmount = newOrderLocked2;

            // 4. Clôture des ordres et remboursement du reliquat non-exécuté si demandé
            if (m.closeOrder1) {
                euint256 refundAvail1 = Nox.add(_available[o1.owner][o1.tokenIn], newOrderLocked1);
                _grantBalanceACL(refundAvail1, o1.owner);
                _available[o1.owner][o1.tokenIn] = refundAvail1;

                euint256 refundLocked1 = Nox.sub(_locked[o1.owner][o1.tokenIn], newOrderLocked1);
                _grantBalanceACL(refundLocked1, o1.owner);
                _locked[o1.owner][o1.tokenIn] = refundLocked1;

                o1.isSettled = true;
            }
            if (m.closeOrder2) {
                euint256 refundAvail2 = Nox.add(_available[o2.owner][o2.tokenIn], newOrderLocked2);
                _grantBalanceACL(refundAvail2, o2.owner);
                _available[o2.owner][o2.tokenIn] = refundAvail2;

                euint256 refundLocked2 = Nox.sub(_locked[o2.owner][o2.tokenIn], newOrderLocked2);
                _grantBalanceACL(refundLocked2, o2.owner);
                _locked[o2.owner][o2.tokenIn] = refundLocked2;

                o2.isSettled = true;
            }

            emit MatchSettled(m.orderId1, m.orderId2, o1.owner, o2.owner, o1.tokenIn, o2.tokenIn);
        }
    }

    function recoverSigner(bytes32 _ethSignedMessageHash, bytes memory _signature) public pure returns (address) {
        (bytes32 r, bytes32 s, uint8 v) = splitSignature(_signature);
        return ecrecover(_ethSignedMessageHash, v, r, s);
    }

    function splitSignature(bytes memory sig) public pure returns (bytes32 r, bytes32 s, uint8 v) {
        require(sig.length == 65, "DarkPoolVault: Invalid signature length");
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
    }
}
