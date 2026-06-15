// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {TEEType} from "@iexec-nox/nox-protocol-contracts/contracts/utils/TypeUtils.sol";

/**
 * @title MockNoxCompute
 * @dev Simulateur "FHE transparent" pour les tests Hardhat : chaque handle est associé
 *      à sa valeur en clair dans `values`, et les opérations chiffrées (add/sub/le/select)
 *      calculent réellement. Les tests peuvent :
 *      - injecter la valeur d'un handle client via setHandleValue() avant submitOrder ;
 *      - lire la valeur de n'importe quel handle (solde chiffré, verdict de solvabilité)
 *        via getValue() pour asserter la logique confidentielle du vault.
 *      Un handle inconnu vaut 0 — ce qui couvre naturellement le zeroHandle de la lib Nox.
 */
contract MockNoxCompute {
    mapping(bytes32 => uint256) public values;
    mapping(bytes32 => mapping(address => bool)) public granted;
    uint256 private nonce;

    function _newHandle(uint256 v) internal returns (bytes32 h) {
        // bit 0 de l'octet 6 forcé à 1 : handle "unique" (non public) comme en production
        h = keccak256(abi.encode(v, ++nonce)) | bytes32(uint256(1) << ((31 - 6) * 8));
        values[h] = v;
    }

    // ── Helpers de test ──────────────────────────────────────────────────────
    function setHandleValue(bytes32 handle, uint256 value) external {
        values[handle] = value;
    }

    function getValue(bytes32 handle) external view returns (uint256) {
        return values[handle];
    }

    // ── API appelée par la librairie Nox ────────────────────────────────────
    function validateInputProof(
        bytes32 handle,
        address sender,
        bytes calldata proof,
        TEEType teeType
    ) external pure {
        // Toujours valide pour les tests locaux Hardhat
    }

    function wrapAsPublicHandle(bytes32 value, TEEType) external returns (bytes32 h) {
        // Déterministe, octet 6 à 0 (handle public) comme en production
        h = keccak256(abi.encode("public", value)) & ~bytes32(uint256(0xff) << ((31 - 6) * 8));
        values[h] = uint256(value);
    }

    function add(bytes32 a, bytes32 b) external returns (bytes32) {
        return _newHandle(values[a] + values[b]);
    }

    function sub(bytes32 a, bytes32 b) external returns (bytes32) {
        return _newHandle(values[a] - values[b]);
    }

    function le(bytes32 a, bytes32 b) external returns (bytes32) {
        return _newHandle(values[a] <= values[b] ? 1 : 0);
    }

    function select(bytes32 cond, bytes32 ifTrue, bytes32 ifFalse) external returns (bytes32) {
        return _newHandle(values[cond] == 1 ? values[ifTrue] : values[ifFalse]);
    }

    // Primitive atomique : échoue (sans modifier les soldes) si balanceFrom < amount
    function transfer(
        bytes32 balanceFrom,
        bytes32 balanceTo,
        bytes32 amount
    ) external returns (bytes32 success, bytes32 newBalanceFrom, bytes32 newBalanceTo) {
        bool ok = values[balanceFrom] >= values[amount];
        success = _newHandle(ok ? 1 : 0);
        newBalanceFrom = _newHandle(ok ? values[balanceFrom] - values[amount] : values[balanceFrom]);
        newBalanceTo = _newHandle(ok ? values[balanceTo] + values[amount] : values[balanceTo]);
    }

    // Échoue uniquement sur overflow du totalSupply — non reproduit dans les tests
    function mint(
        bytes32 balanceTo,
        bytes32 amount,
        bytes32 totalSupply
    ) external returns (bytes32 success, bytes32 newBalanceTo, bytes32 newTotalSupply) {
        success = _newHandle(1);
        newBalanceTo = _newHandle(values[balanceTo] + values[amount]);
        newTotalSupply = _newHandle(values[totalSupply] + values[amount]);
    }

    // Échoue (sans modifier les soldes) si balanceFrom < amount
    function burn(
        bytes32 balanceFrom,
        bytes32 amount,
        bytes32 totalSupply
    ) external returns (bytes32 success, bytes32 newBalanceFrom, bytes32 newTotalSupply) {
        bool ok = values[balanceFrom] >= values[amount];
        success = _newHandle(ok ? 1 : 0);
        newBalanceFrom = _newHandle(ok ? values[balanceFrom] - values[amount] : values[balanceFrom]);
        newTotalSupply = _newHandle(ok ? values[totalSupply] - values[amount] : values[totalSupply]);
    }

    function allow(bytes32 handle, address account) external {
        granted[handle][account] = true;
    }

    function allowTransient(bytes32 handle, address account) external {
        granted[handle][account] = true;
    }

    function disallowTransient(bytes32 handle, address account) external {
        granted[handle][account] = false;
    }

    // ── Décryption publique (unwrap du ConfidentialToken) ───────────────────
    mapping(bytes32 => bool) public publiclyDecryptable;

    function allowPublicDecryption(bytes32 handle) external {
        publiclyDecryptable[handle] = true;
    }

    function isPubliclyDecryptable(bytes32 handle) external view returns (bool) {
        return publiclyDecryptable[handle];
    }

    /**
     * @dev La preuve de la gateway n'est pas reproduite : le mock renvoie directement
     *      la valeur du handle au format ebool (1 octet), comme le ferait
     *      validateDecryptionProof après vérification de la signature.
     */
    function validateDecryptionProof(
        bytes32 handle,
        bytes calldata
    ) external view returns (bytes memory) {
        require(publiclyDecryptable[handle], "MockNoxCompute: Not publicly decryptable");
        return abi.encodePacked(values[handle] == 1 ? bytes1(0x01) : bytes1(0x00));
    }
}
