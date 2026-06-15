# Nox Dark Pool — Roadmap

> Priorisation des fonctionnalités pour démontrer la force d'iExec Nox
> (calcul confidentiel on-chain via handles chiffrés + TEE + KMS).
> Mise à jour : 2026-06-12 — **P0 finalisé** (P0.3 & P0.4 livrés, 46 tests verts).

---

## 🔶 P0 — Confidentialité de bout en bout et Anonymat

### P0.1 Soldes chiffrés + règlement confidentiel ✅
Les soldes (`_available` / `_locked`) sont des `euint256` : invisibles sur Etherscan.
Le règlement échange les séquestres chiffrés (`Nox.add`/`Nox.sub`) et `MatchSettled`
ne publie **aucun montant**. L'enclave ne transmet que `(orderId1, orderId2, salt)` signés.
Seuls les dépôts/retraits restent publics (transferts ERC-20, incompressible).

### P0.2 Solvabilité vérifiée sur chiffrés ✅
À la soumission : `ok = Nox.le(amountIn, solde)` puis séquestre
`lockAmt = Nox.select(ok, amountIn, 0)` — ni le montant, ni le solde, ni le verdict
ne sont révélés on-chain. L'enclave déchiffre `ok` via le KMS et ignore les ordres
insolvables. Corollaire indispensable : file de retraits idempotente
(`pendingWithdrawals`) — une demande = une exécution maximum (anti-double-paiement
prouvé on-chain et couvert par les tests).

### P0.3 Dépôts et Retraits 100% confidentiels via le wrapper de Token Confidentiel Nox ✅
Le SDK Nox 0.2.4 ne fournissant pas de wrapper natif, `ConfidentialToken.sol` l'implémente
avec les primitives atomiques du protocole (`Nox.mint`/`Nox.burn`/`Nox.transfer`) :
- `wrap` / `wrapTo` : entrée publique (incompressible), fondue immédiatement dans un
  solde chiffré `euint256` ;
- transferts confidentiels sans revert ni fuite (0 chiffré si insolvable) ;
- `requestUnwrap` + `finalizeUnwrap` : sortie en deux temps, le verdict (1 bit) est rendu
  publiquement déchiffrable et vérifié on-chain par `Nox.publicDecrypt` (preuve signée
  par la gateway KMS, soumissible par n'importe qui — trustless).
Le vault accepte `depositConfidential` / `withdrawConfidential` : aucun montant en clair,
et le retrait confidentiel est **synchrone** (couverture vérifiée sur chiffrés via
`Nox.le`/`Nox.select` — ni file d'attente, ni enclave). Couvert par les tests
`test/ConfidentialFlows.test.js`.

### P0.4 Client de Trading Furtif (Stealth Addresses & Relayers) ✅
- `src/client/stealth.ts` : dérivation déterministe d'adresses jetables (clé furtive =
  keccak d'une signature du wallet principal — récupérable, jamais stockée) + helpers de
  signature des meta-transactions.
- Meta-transactions on-chain : `submitOrderFor`, `depositConfidentialFor`,
  `withdrawConfidentialFor` (vault) et `setOperatorWithSig`, `transferEncryptedWithSig`,
  `requestUnwrapWithSig` (wrapper). Digest EIP-191 liant chainid + contrat + action +
  paramètres + nonce séquentiel (anti-rejeu, anti-substitution). Les preuves de handles
  sont validées contre l'owner déclaré (le proof Nox encode son créateur) et non contre
  le relayer.
- `src/relayer/index.ts` : service HTTP qui soumet les meta-tx et paie le gas (cibles
  whitelistées, pré-validation par estimation de gas). L'adresse furtive n'a JAMAIS
  besoin d'ETH ; le wallet principal n'apparaît jamais côté trading.
- Scénario e2e furtif complet couvert par les tests : wrap → transfert confidentiel vers
  l'adresse furtive → dépôt/ordre/règlement/retrait relayés → sortie sans gas.
- Test d'intégration réseau : `npm run e2e:confidential`
  (`scripts/e2e-confidential-sepolia.mjs`) rejoue ce scénario contre Sepolia avec le
  KMS réel (preuves de handles + preuve de décryption d'unwrap). Nécessite le
  redéploiement v3.2 (vault + wrappers) — le vault v3.1 actif ne les expose pas.

### P0.5 Anonymat Avancé et Protection contre l'Analyse Blockchain ⏳
Pour rendre le système de trading furtif réellement sans faille et indétectable (façon Tornado Cash / ERC-5564) :
- **Stealth Addresses à usage unique** : Générer une nouvelle adresse furtive pour chaque dépôt ou trade (au lieu d'une adresse fixe par wallet principal) pour empêcher la corrélation et l'analyse de liens entre trades successifs (*unlinkability*).
- **Montants standardisés (Anonymity Sets)** : Imposer des tailles de dépôts/retraits fixes (ex: pile 0.1, 1, 10 WETH/USDC) pour casser la corrélation statistique des montants entrés et sortis de la zone de confidentialité.
- **Routage réseau et Relayer décentralisé** : Passer par un réseau de relayeurs décentralisés (ex: via Waku) et forcer le routage par VPN/Tor pour masquer l'adresse IP de l'utilisateur lors de la soumission de la méta-transaction au Relayer.
- **Retrait vers des adresses tierces (Exit to clean wallet)** : Permettre l'envoi confidentiel des fonds du wrapper furtif vers n'importe quelle adresse Ethereum de destination (Champ de saisie de destinataire implémenté dans l'UI) pour rompre tout lien public avec le wallet d'origine lors de l'off-ramp.

---

## 🔶 P1 — Crédibilité de l'histoire TEE

### P1.1 Déployer le matching engine comme vraie iApp confidentielle iExec
Aujourd'hui l'« enclave » est un script Node avec une clé privée dans `.env` :
quiconque possède la clé EST l'enclave. La force d'iExec est l'**attestation** :
- exécuter l'engine sur un worker TEE du réseau iExec ;
- générer la clé de signature DANS l'enclave (elle n'en sort jamais) ;
- publier la mesure (MRENCLAVE) et lier `enclaveAddress` du vault au code attesté.
C'est la différence entre « faites-moi confiance » et « vérifiez ».
Bonus : persister le carnet d'ordres (chiffré) pour survivre aux redémarrages.

### P1.2 Garde-fou de prix via oracle dans le TEE
Le « midpoint » des dark pools traditionnels : l'enclave lit un prix de référence
(Chainlink on-chain, ou une API web2 type Binance — avantage unique du TEE : il peut
consommer du web2 de façon vérifiable) et ne matche que si le prix implicite du
croisement est dans ±N % du marché. Empêche un échange accidentel à 8× sous le prix
et protège les utilisateurs distraits sur le `minAmountOut`.

---

## 🔷 P2 — Réalisme trading

### P2.1 Exécutions partielles
Un ordre de 0.05 WETH doit pouvoir être servi par 5 contre-ordres de 0.01.
Nécessite : montants résiduels chiffrés dans l'ordre (`Nox.sub` à chaque fill),
séquestre décrémenté progressivement, état `PartiallyFilled` dans l'UI.

### P2.2 Expiration des ordres (TTL) + nettoyage
Champ `expiresAt` public dans l'ordre ; l'enclave écarte les ordres expirés et
n'importe qui peut appeler `expireOrder(id)` pour déséquestrer (incitation possible).

### P2.3 Prix d'exécution médian
Au lieu de « chacun reçoit le amountIn de l'autre » (surplus intégral à la
contrepartie), exécuter au point médian des deux limites — plus équitable, et
c'est le standard des dark pools réels. Calculable dans l'enclave (off-chain, en clair).

### P2.4 Démo multi-wallets
Script de démo avec 2-3 wallets distincts (Alice/Bob) pour montrer le récit
« deux contreparties qui ne se connaissent pas » — aujourd'hui tous les tests
tradent contre le même wallet, le self-trade masque l'intérêt du produit.

### P2.5 Pools de Liquidité Confidentiels (Modèle AMM / Peer-to-Pool) ⏳
Transitionner d'un carnet d'ordres Peer-to-Peer à un modèle d'AMM confidentiel pour garantir une liquidité immédiate et résoudre la coïncidence des besoins :
- **Pools à montants chiffrés** : Les LPs (fournisseurs de liquidité) déposent des fonds dans des pools communes où les réserves globales et les parts individuelles sont entièrement chiffrées par le KMS (solde invisible on-chain).
- **Swaps instantanés au prix du marché** : Le trader swap ses jetons confidentiels directement contre la pool. Le TEE (enclave) interroge un oracle de prix (ex: Chainlink) et exécute la transaction immédiatement.
- **Protection absolue contre le MEV (Front-Running)** : La transaction du trader arrivant cryptée dans la mempool, aucun robot d'arbitrage ne peut voir la taille ni la direction du swap avant son exécution dans l'enclave, éliminant totalement les attaques en sandwich.
- **Rémunération des LPs** : Prélèvement de frais de trading (ex: 0.3%) sur les swaps au profit des apporteurs de liquidités confidentielles.

---

## 🔹 P3 — Robustesse production

### P3.1 Matching engine testable et persistant
Extraire `runMatchingEngine` dans un module pur (sans I/O) avec tests unitaires
dédiés (priorité prix/ancienneté, multi-matches par cycle). Persister le carnet
déchiffré dans un stockage chiffré (sealed storage TEE) pour survivre aux restarts.

### P3.2 Haute disponibilité de l'enclave sans double-exécution
Le bug du jour (3 paiements pour 1 retrait avec 2 enclaves v3.0) est corrigé côté
retraits ; généraliser : verrou de leader (un seul signataire actif), nonces de
règlement séquentiels, idempotence systématique de toute action signée par l'enclave.

### P3.3 Multi-paires et monétisation du Relayer/Enclave
- Whitelist de tokens (decimals, oracle associé), support de N paires dans le carnet.
- **Financement du Relayer (Gas Abstraction)** : Prélever des frais de transaction (en `cToken` comme le cUSDC/cWETH) directement sur les ordres ou transferts furtifs pour rembourser et financer les frais de gas en ETH avancés par le Relayer.
- **Agrégation des frais (spread)** pour financer les coûts opérationnels du TEE.

### P3.4 Retraits trustless (sortie de secours)
Si l'enclave disparaît, les fonds chiffrés sont bloqués. Ajouter un mécanisme de
secours : décryption publique différée du solde (`allowPublicDecryption` après un
timeout) ou preuve utilisateur — l'utilisateur ne doit jamais dépendre de la
disponibilité de l'enclave pour récupérer ses fonds.

---

## ▫️ P4 — Polish & adoption

- **UI** : affichage du solde verrouillé par token (pills « In orders »), statut
  des demandes de retrait (pending/rejected via `WithdrawRejected`), notifications
  de fill en temps réel (websocket/event subscription), historique des trades.
- **Indexeur** : subgraph ou indexeur léger pour ne plus scanner les blocs depuis
  `VAULT_DEPLOY_BLOCK` à chaque chargement.
- **Audit** : revue de sécurité du contrat (séquestre chiffré, underflow de
  `Nox.sub` non-revertant, ACL minimales par handle).
- **Docs** : architecture (diagramme contrat ↔ enclave ↔ KMS), guide de déploiement,
  runbook opérateur (« UNE seule enclave », rotation de clé via
  `updateEnclaveAddress`).

---

## Historique des vaults (Sepolia)

| Version | Adresse | État |
|---|---|---|
| v1 | `0x2aAB9826…a502` | ACL manquante (ordres indéchiffrables) — vidé |
| v2 | `0x01D05e5F…2780` | Soldes publics, règlement en clair — vidé |
| v3.0 | `0xa5107D17…27f5` | Confidentiel mais retraits non idempotents — vidé |
| **v3.1** | **`0x85641d86…0aEb`** | **Actif** — confidentialité E2E + file de retraits |
