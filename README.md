# MVP Dark Pool Décentralisé sur iExec Nox (Sepolia Testnet)

Ce projet fournit un MVP complet et prêt pour la production d'un **Dark Pool Décentralisé** exploitant la technologie de calcul confidentiel (TEE - Intel TDX) d'**iExec Nox** sur le testnet Ethereum Sepolia.

Il contient :
1. Un smart contract Solidity (`DarkPoolVault.sol`) robuste avec protection contre la réentrance et le rejeu.
2. Un wrapper de token confidentiel (`ConfidentialToken.sol`, ex: cWETH/cUSDC) pour des dépôts/retraits 100% confidentiels (P0.3).
3. Une application de moteur d'appariement confidentiel en enclave TEE (`src/enclave/index.ts`).
4. Un script client d'envoi d'ordres chiffrés (`src/client/index.ts`).
5. Un client de trading furtif (`src/client/stealth.ts`) et son relayer (`src/relayer/index.ts`) : adresses jetables + meta-transactions sans gas (P0.4).

---

## Fonctionnalités Clés & Sécurité

*   **Chiffrement de bout en bout (ECIES)** : Les ordres ne sont jamais transmis en clair sur le réseau ou sur la blockchain. Le client chiffre l'ordre avant son envoi en utilisant la clé publique de l'enclave.
*   **Calcul Confidentiel (Intel TDX)** : L'enclave s'exécute off-chain au sein d'un environnement matériellement isolé et sécurisé (TEE). Le carnet d'ordres et les prix limites restent invisibles en dehors de la mémoire protégée de l'enclave.
*   **Protection Anti-Rejeu (Replay Protection)** :
    *   **Multi-contrats/réseaux** : Les signatures de règlement générées par l'enclave intègrent le `chainId` de la chaîne cible et l'adresse physique du contrat `DarkPoolVault`.
    *   **Rejeu de règlement** : Le contrat conserve l'historique des correspondances à travers un hachage unique contenant un `salt` généré aléatoirement.
*   **Vérification de Solvabilité** : Le contrat gère les fonds on-chain et effectue les débits de manière transactionnelle sécurisée via les fonctions de soustraction natives de Solidity (revert automatique si solde insuffisant).
*   **Dépôts/Retraits confidentiels (P0.3)** : via le wrapper `ConfidentialToken` (cWETH/cUSDC), les flux d'entrée/sortie du Dark Pool sont des transferts chiffrés (`euint256`) — aucun montant n'apparaît sur Etherscan. Le retrait confidentiel est synchrone (couverture vérifiée sur chiffrés, sans enclave). L'unwrap vers l'ERC-20 public se finalise avec une preuve de décryption KMS vérifiée on-chain.
*   **Trading Furtif (P0.4)** : adresses jetables dérivées de façon déterministe du wallet principal + meta-transactions relayées (`*For` / `*WithSig`). L'adresse furtive ne détient jamais d'ETH (le relayer paie le gas) et le wallet principal n'apparaît jamais côté trading : le wrapper confidentiel masque le « combien », le couple stealth/relayer masque le « qui ».

---

## Structure du Workspace

```text
├── contracts/
│   ├── DarkPoolVault.sol    # Smart Contract principal (v3.2)
│   └── ConfidentialToken.sol # Wrapper de token confidentiel Nox (cWETH/cUSDC)
├── src/
│   ├── client/
│   │   ├── index.ts         # Script d'envoi et chiffrement d'ordres client (CLI)
│   │   └── stealth.ts       # Client furtif : stealth addresses + signatures meta-tx
│   ├── enclave/
│   │   └── index.ts         # Moteur de matching confidentiel en TEE
│   ├── relayer/
│   │   └── index.ts         # Relayer HTTP des meta-transactions (paie le gas)
│   └── frontend/
│       ├── app.ts           # Logique Web3 interactive du dashboard
│       └── style.css        # Styles CSS sombres et premium
├── index.html               # Page d'accueil du dashboard Web3
├── package.json             # Dépendances et scripts de build
├── tsconfig.json            # Configuration TypeScript
├── .env.example             # Modèle de configuration des variables d'environnement
└── README.md                # Guide d'utilisation
```

---

## Installation & Configuration

1. **Installer les dépendances** :
   ```bash
   npm install
   ```

2. **Configurer les variables d'environnement** :
   Copiez le fichier `.env.example` et nommez-le `.env` :
   ```bash
   cp .env.example .env
   ```
   Remplissez ensuite les variables requises (URL RPC Sepolia, clé de signature, clés ECIES de l'enclave et adresse du vault).

---

## Compilation & Construction (Build)

*   **Compiler le Smart Contract Solidity** :
    ```bash
    npx hardhat compile
    ```

*   **Déployer le Smart Contract Solidity (Sepolia)** :
    ```bash
    npx hardhat run scripts/deploy.ts --network sepolia
    ```

*   **Compiler le Code TypeScript (Client et Enclave)** :
    ```bash
    npm run build
    ```

*   **Compiler le Frontend Web3 pour la Production** :
    ```bash
    npm run build:frontend
    ```

---

## Exécution

1. **Lancer le serveur de développement Frontend local** :
   ```bash
   npm run dev
   ```
   Ouvrez ensuite le lien fourni (ex: `http://localhost:5173`) dans votre navigateur contenant MetaMask (connecté à Sepolia).

2. **Lancer le Matching Engine Confidentiel (Enclave)** :
   ```bash
   npm run enclave
   ```

3. **Soumettre un Ordre Chiffré via le client CLI (Optionnel)** :
   ```bash
   npm run client
   ```

4. **Test E2E confidentiel sur Sepolia (P0.3 + P0.4)** :
   ```bash
   npm run build          # compile les helpers du client furtif
   npm run e2e:confidential
   ```
   Rejoue le scénario furtif complet contre Sepolia : wrap → transfert confidentiel vers
   l'adresse furtive → dépôt/ordre relayés (gasless) → match par l'enclave → retrait
   confidentiel synchrone → unwrap avec preuve de décryption KMS vérifiée on-chain.
   Prérequis : vault v3.2 + wrappers déployés (`VAULT_ADDRESS`, `CWETH_ADDRESS`,
   `CUSDC_ADDRESS` dans le `.env`), enclave lancée, wallet financé (voir l'en-tête du
   script). Le test E2E historique v3.1 reste disponible via `npm run e2e`.

5. **Lancer le Relayer du client furtif (P0.4, Optionnel)** :
   ```bash
   npm run relayer
   ```
   Variables requises : `RELAYER_PRIVATE_KEY` (wallet financé qui paie le gas),
   `VAULT_ADDRESS`, `CTOKEN_ADDRESSES` (adresses cWETH/cUSDC séparées par des virgules),
   `RELAYER_PORT` (optionnel, défaut 9545). Endpoint : `POST /relay`
   avec `{ action, params }` — voir `src/client/stealth.ts` pour la construction et la
   signature des meta-transactions côté client.
