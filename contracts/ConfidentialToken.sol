// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";
import {INoxCompute} from "@iexec-nox/nox-protocol-contracts/contracts/interfaces/INoxCompute.sol";
import {TEEType} from "@iexec-nox/nox-protocol-contracts/contracts/utils/TypeUtils.sol";

/**
 * @title ConfidentialToken (P0.3)
 * @dev Wrapper de token confidentiel Nox (ex: cWETH, cUSDC) autour d'un ERC-20 public.
 *
 *      - `wrap` : entrée publique (le transfert ERC-20 sous-jacent est incompressible),
 *        le montant est immédiatement fondu dans un solde chiffré (euint256).
 *      - `transferEncrypted` / `operatorTransfer` : transferts 100% confidentiels via la
 *        primitive atomique Nox.transfer — si le solde est insuffisant, le transfert vaut
 *        0 chiffré, sans revert ni fuite d'information.
 *      - `requestUnwrap` + `finalizeUnwrap` : sortie publique en deux temps. Le contrat
 *        débite le solde chiffré (Nox.burn), rend le verdict (1 bit) publiquement
 *        déchiffrable, puis N'IMPORTE QUI peut finaliser avec la preuve de décryption
 *        signée par la gateway KMS (Nox.publicDecrypt). Seul le verdict est révélé —
 *        jamais le solde.
 *      - `setOperator(WithSig)` : autorise un contrat (le DarkPoolVault) à déplacer le
 *        solde chiffré du détenteur ; la variante WithSig est relayable (P0.4) pour que
 *        les adresses furtives n'aient jamais besoin de gas.
 */
contract ConfidentialToken is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable underlying;
    string public name;
    string public symbol;
    uint8 public immutable decimals;

    euint256 private _totalSupply;
    mapping(address => euint256) private _balances;

    // Opérateurs autorisés à déplacer le solde chiffré d'un détenteur (ex: le vault)
    mapping(address => mapping(address => bool)) public isOperator;
    // Nonces des signatures meta (anti-rejeu)
    mapping(address => uint256) public metaNonces;

    struct UnwrapRequest {
        address user;
        uint256 amount;
        ebool ok;
        bool finalized;
    }

    uint256 public nextUnwrapId;
    mapping(uint256 => UnwrapRequest) public unwrapRequests;

    event Wrapped(address indexed from, address indexed to, uint256 amount);
    // Aucun montant : le transfert est entièrement confidentiel
    event ConfidentialTransfer(address indexed from, address indexed to);
    event OperatorSet(address indexed holder, address indexed operator, bool approved);
    event UnwrapRequested(uint256 indexed requestId, address indexed user, uint256 amount, bytes32 okHandle);
    event Unwrapped(uint256 indexed requestId, address indexed user, uint256 amount);
    event UnwrapRejected(uint256 indexed requestId, address indexed user, uint256 amount);

    constructor(IERC20 _underlying, string memory _name, string memory _symbol, uint8 _decimals) {
        underlying = _underlying;
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
    }

    // ============ Lecture des handles chiffrés ============

    function balanceOf(address account) external view returns (bytes32) {
        return euint256.unwrap(_balances[account]);
    }

    function totalSupplyHandle() external view returns (bytes32) {
        return euint256.unwrap(_totalSupply);
    }

    /**
     * @dev Chaque opération Nox produit un NOUVEAU handle : re-déclarer à chaque fois
     *      qui a le droit de l'utiliser (le contrat pour les calculs futurs, le
     *      détenteur pour le déchiffrement KMS).
     */
    function _setBalance(address holder, euint256 newBal) private {
        Nox.allowThis(newBal);
        Nox.allow(newBal, holder);
        _balances[holder] = newBal;
    }

    // ============ Wrap (entrée publique -> solde chiffré) ============

    function wrap(uint256 amount) external {
        wrapTo(msg.sender, amount);
    }

    /**
     * @dev Wrap vers un tiers (ex: créditer directement une adresse furtive).
     *      Le montant wrappé est public ; il disparaît ensuite du radar.
     */
    function wrapTo(address to, uint256 amount) public nonReentrant {
        require(amount > 0, "ConfidentialToken: Amount must be greater than 0");
        // mint ne peut échouer que sur un overflow du totalSupply chiffré — impossible
        // tant que l'offre du sous-jacent tient dans uint256.
        (, euint256 newBal, euint256 newSupply) = Nox.mint(
            _balances[to],
            Nox.toEuint256(amount),
            _totalSupply
        );
        _setBalance(to, newBal);
        Nox.allowThis(newSupply);
        _totalSupply = newSupply;
        underlying.safeTransferFrom(msg.sender, address(this), amount);
        emit Wrapped(msg.sender, to, amount);
    }

    // ============ Transferts confidentiels ============

    /**
     * @dev Transfert confidentiel initié par le détenteur : le montant est un handle
     *      chiffré fourni avec sa preuve. Si le solde est insuffisant, 0 est transféré
     *      (aucun revert : un revert révélerait l'insuffisance du solde).
     */
    function transferEncrypted(
        address to,
        externalEuint256 amountExternal,
        bytes calldata amountProof
    ) external returns (bytes32) {
        euint256 amount = Nox.fromExternal(amountExternal, amountProof);
        return euint256.unwrap(_transfer(msg.sender, to, amount));
    }

    /**
     * @dev Transfert confidentiel par un opérateur autorisé (le DarkPoolVault) ou par
     *      le détenteur lui-même via un autre contrat. Retourne le handle du montant
     *      effectivement transféré (= montant demandé, ou 0 chiffré si insolvable),
     *      utilisable par l'appelant dans la même transaction (ACL transitoire).
     */
    function operatorTransfer(address from, address to, euint256 amount) external returns (euint256 transferred) {
        require(
            from == msg.sender || isOperator[from][msg.sender],
            "ConfidentialToken: Not operator"
        );
        transferred = _transfer(from, to, amount);
        Nox.allowTransient(transferred, msg.sender);
    }

    function _transfer(address from, address to, euint256 amount) private returns (euint256 transferred) {
        (ebool ok, euint256 newFrom, euint256 newTo) = Nox.transfer(
            _balances[from],
            _balances[to],
            amount
        );
        transferred = Nox.select(ok, amount, Nox.toEuint256(0));
        Nox.allowThis(transferred);
        Nox.allow(transferred, from);
        Nox.allow(transferred, to);
        _setBalance(from, newFrom);
        _setBalance(to, newTo);
        emit ConfidentialTransfer(from, to);
    }

    // ============ Unwrap (solde chiffré -> sortie publique, en deux temps) ============

    /**
     * @dev Débite le solde chiffré (0 si insuffisant, via Nox.burn) et rend le verdict
     *      publiquement déchiffrable. Le montant demandé est public — inévitable, le
     *      transfert ERC-20 de sortie l'est aussi.
     */
    function requestUnwrap(uint256 amount) external returns (uint256 requestId) {
        return _requestUnwrap(msg.sender, amount);
    }

    function _requestUnwrap(address user, uint256 amount) private returns (uint256 requestId) {
        require(amount > 0, "ConfidentialToken: Amount must be greater than 0");
        (ebool ok, euint256 newBal, euint256 newSupply) = Nox.burn(
            _balances[user],
            Nox.toEuint256(amount),
            _totalSupply
        );
        _setBalance(user, newBal);
        Nox.allowThis(newSupply);
        _totalSupply = newSupply;

        Nox.allowThis(ok);
        Nox.allow(ok, user);
        // Seul ce bit (couvert/pas couvert) devient public — jamais le solde.
        Nox.allowPublicDecryption(ok);

        requestId = nextUnwrapId++;
        unwrapRequests[requestId] = UnwrapRequest({
            user: user,
            amount: amount,
            ok: ok,
            finalized: false
        });
        emit UnwrapRequested(requestId, user, amount, ebool.unwrap(ok));
    }

    /**
     * @dev Finalise un unwrap avec la preuve de décryption signée par la gateway KMS.
     *      Trustless : n'importe qui peut soumettre la preuve, le contrat la vérifie
     *      on-chain (Nox.publicDecrypt). Si le solde était insuffisant, rien n'avait
     *      été débité et rien n'est payé.
     */
    function finalizeUnwrap(uint256 requestId, bytes calldata decryptionProof) external nonReentrant {
        UnwrapRequest storage r = unwrapRequests[requestId];
        require(r.user != address(0), "ConfidentialToken: Unknown request");
        require(!r.finalized, "ConfidentialToken: Already finalized");
        r.finalized = true;

        if (Nox.publicDecrypt(r.ok, decryptionProof)) {
            underlying.safeTransfer(r.user, r.amount);
            emit Unwrapped(requestId, r.user, r.amount);
        } else {
            emit UnwrapRejected(requestId, r.user, r.amount);
        }
    }

    // ============ Opérateurs (direct + meta-signature relayable) ============

    function setOperator(address operator, bool approved) external {
        _setOperator(msg.sender, operator, approved);
    }

    /**
     * @dev Variante relayable (P0.4) : l'adresse furtive signe hors-chaîne, le relayer
     *      paie le gas. Le digest inclut chainid + adresse du contrat (anti-rejeu
     *      cross-chain/cross-contract) et un nonce séquentiel.
     */
    function setOperatorWithSig(
        address holder,
        address operator,
        bool approved,
        uint256 nonce,
        bytes calldata signature
    ) external {
        bytes32 digest = keccak256(
            abi.encode(block.chainid, address(this), "setOperator", holder, operator, approved, nonce)
        );
        _verifyMetaSig(holder, nonce, digest, signature);
        _setOperator(holder, operator, approved);
    }

    /**
     * @dev Transfert confidentiel relayé : permet à une adresse furtive de déplacer
     *      ses tokens confidentiels (ex: vers un wallet propre) sans jamais payer de gas.
     */
    function transferEncryptedWithSig(
        address holder,
        address to,
        externalEuint256 amountExternal,
        bytes calldata amountProof,
        uint256 nonce,
        bytes calldata signature
    ) external returns (bytes32) {
        bytes32 digest = keccak256(
            abi.encode(
                block.chainid,
                address(this),
                "transferEncrypted",
                holder,
                to,
                externalEuint256.unwrap(amountExternal),
                nonce
            )
        );
        _verifyMetaSig(holder, nonce, digest, signature);
        euint256 amount = _fromExternalFor(amountExternal, amountProof, holder);
        return euint256.unwrap(_transfer(holder, to, amount));
    }

    /**
     * @dev Unwrap relayé : la demande est signée par le détenteur, le relayer paie le gas.
     */
    function requestUnwrapWithSig(
        address holder,
        uint256 amount,
        uint256 nonce,
        bytes calldata signature
    ) external returns (uint256) {
        bytes32 digest = keccak256(
            abi.encode(block.chainid, address(this), "requestUnwrap", holder, amount, nonce)
        );
        _verifyMetaSig(holder, nonce, digest, signature);
        return _requestUnwrap(holder, amount);
    }

    function _setOperator(address holder, address operator, bool approved) private {
        isOperator[holder][operator] = approved;
        emit OperatorSet(holder, operator, approved);
    }

    function _verifyMetaSig(address holder, uint256 nonce, bytes32 digest, bytes calldata signature) private {
        require(nonce == metaNonces[holder], "ConfidentialToken: Bad nonce");
        metaNonces[holder] = nonce + 1;
        address signer = ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(digest), signature);
        require(signer == holder, "ConfidentialToken: Invalid meta signature");
    }

    /**
     * @dev Équivalent de Nox.fromExternal mais la preuve est validée contre le
     *      détenteur déclaré : le relayer (msg.sender) n'est qu'un transporteur.
     */
    function _fromExternalFor(
        externalEuint256 externalHandle,
        bytes calldata proof,
        address holder
    ) private returns (euint256) {
        bytes32 handle = externalEuint256.unwrap(externalHandle);
        INoxCompute(Nox.noxComputeContract()).validateInputProof(handle, holder, proof, TEEType.Uint256);
        return euint256.wrap(handle);
    }
}
