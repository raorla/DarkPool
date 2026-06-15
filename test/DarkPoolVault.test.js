const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * Suite de tests du DarkPoolVault v3.1 — confidentialité de bout en bout.
 *
 * Le MockNoxCompute est un simulateur "FHE transparent" : les handles sont liés à
 * leurs valeurs en clair dans le mock, ce qui permet d'asserter la logique chiffrée
 * (solvabilité, séquestre, règlement, retraits) sans KMS ni TEE réels.
 */
describe("DarkPoolVault v3.1", function () {
  let vault, vaultAddress;
  let mock;
  let token1, token2, token1Address, token2Address;
  let owner, user1, user2, enclaveSigner;
  let user1Address, user2Address, enclaveAddress;

  const INITIAL_SUPPLY = ethers.parseEther("1000000");
  const MOCK_NOX_ADDRESS = "0x75C6AF4430cc474b1bb9b8540b7E46D6f8e1C685"; // adresse Hardhat attendue par Nox.sol

  // Compteur global pour générer des handles de test uniques
  let handleSeed = 0;
  function newHandle() {
    handleSeed++;
    // octet 6 avec bit 0 à 1 -> handle "unique" (non public)
    return ethers.toBeHex((BigInt(handleSeed) << 208n) | (1n << 200n) | BigInt(handleSeed), 32);
  }

  /** Enregistre un montant en clair pour un handle côté mock, comme le ferait le KMS. */
  async function makeAmountHandle(amount) {
    const h = newHandle();
    await mock.setHandleValue(h, amount);
    return h;
  }

  /** Lit la valeur en clair d'un solde chiffré du vault. */
  async function decryptedBalance(fn, user, token) {
    const handle = await vault[fn](user, token);
    if (handle === ethers.ZeroHash) return 0n;
    return await mock.getValue(handle);
  }

  /** Soumet un ordre avec des montants contrôlés. */
  async function submitOrder(signer, tokenIn, tokenOut, amountIn, minAmountOut) {
    const aIn = await makeAmountHandle(amountIn);
    const mOut = await makeAmountHandle(minAmountOut);
    return vault.connect(signer).submitOrder(tokenIn, tokenOut, aIn, "0x00", mOut, "0x00");
  }

  /** Signe un règlement v3.2 avec exécutions partielles. */
  async function signMatches(signer, matchesArray) {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const matchesAbiString = "tuple(uint256 orderId1, uint256 orderId2, bytes32 amount1To2External, bytes amount1To2Proof, bytes32 amount2To1External, bytes amount2To1Proof, bool closeOrder1, bool closeOrder2, uint256 salt)[]";
    const encodedData = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "address", matchesAbiString],
      [chainId, vaultAddress, matchesArray]
    );
    return signer.signMessage(ethers.getBytes(ethers.keccak256(encodedData)));
  }

  beforeEach(async function () {
    [owner, user1, user2, enclaveSigner] = await ethers.getSigners();
    user1Address = await user1.getAddress();
    user2Address = await user2.getAddress();
    enclaveAddress = await enclaveSigner.getAddress();

    // Déployer le mock et copier son bytecode à l'adresse statique attendue par Nox.sol (chainid 31337)
    const MockNoxCompute = await ethers.getContractFactory("MockNoxCompute");
    const deployedMock = await MockNoxCompute.deploy();
    await deployedMock.waitForDeployment();
    const mockCode = await ethers.provider.getCode(await deployedMock.getAddress());
    await ethers.provider.send("hardhat_setCode", [MOCK_NOX_ADDRESS, mockCode]);
    mock = await ethers.getContractAt("MockNoxCompute", MOCK_NOX_ADDRESS);

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    token1 = await MockERC20.deploy("Mock WETH", "mWETH", INITIAL_SUPPLY);
    token2 = await MockERC20.deploy("Mock USDC", "mUSDC", INITIAL_SUPPLY);
    await token1.waitForDeployment();
    await token2.waitForDeployment();
    token1Address = await token1.getAddress();
    token2Address = await token2.getAddress();

    const DarkPoolVault = await ethers.getContractFactory("DarkPoolVault");
    vault = await DarkPoolVault.deploy(enclaveAddress);
    await vault.waitForDeployment();
    vaultAddress = await vault.getAddress();

    await token1.transfer(user1Address, ethers.parseEther("50000"));
    await token2.transfer(user2Address, ethers.parseEther("50000"));
  });

  // ════════════════════════════════════════════════════════════════════════
  describe("Déploiement", function () {
    it("définit le bon signataire d'enclave", async function () {
      expect(await vault.enclaveAddress()).to.equal(enclaveAddress);
    });

    it("définit le bon propriétaire", async function () {
      expect(await vault.owner()).to.equal(await owner.getAddress());
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  describe("Dépôts (soldes chiffrés)", function () {
    it("transfère les tokens et crédite le solde chiffré", async function () {
      const amount = ethers.parseEther("10");
      await token1.connect(user1).approve(vaultAddress, amount);

      await expect(vault.connect(user1).deposit(token1Address, amount))
        .to.emit(vault, "Deposit")
        .withArgs(user1Address, token1Address, amount);

      expect(await token1.balanceOf(vaultAddress)).to.equal(amount);
      expect(await decryptedBalance("availableBalanceOf", user1Address, token1Address)).to.equal(amount);
      expect(await decryptedBalance("lockedBalanceOf", user1Address, token1Address)).to.equal(0n);
    });

    it("accumule plusieurs dépôts dans le solde chiffré", async function () {
      await token1.connect(user1).approve(vaultAddress, ethers.parseEther("7"));
      await vault.connect(user1).deposit(token1Address, ethers.parseEther("3"));
      await vault.connect(user1).deposit(token1Address, ethers.parseEther("4"));
      expect(await decryptedBalance("availableBalanceOf", user1Address, token1Address)).to.equal(ethers.parseEther("7"));
    });

    it("rejette un dépôt nul", async function () {
      await expect(vault.connect(user1).deposit(token1Address, 0))
        .to.be.revertedWith("DarkPoolVault: Amount must be greater than 0");
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  describe("Retraits (file asynchrone via l'enclave)", function () {
    const deposited = ethers.parseEther("10");

    beforeEach(async function () {
      await token1.connect(user1).approve(vaultAddress, deposited);
      await vault.connect(user1).deposit(token1Address, deposited);
    });

    it("requestWithdraw enregistre la demande et émet l'événement", async function () {
      const amount = ethers.parseEther("4");
      await expect(vault.connect(user1).requestWithdraw(token1Address, amount))
        .to.emit(vault, "WithdrawRequested")
        .withArgs(user1Address, token1Address, amount);
      expect(await vault.pendingWithdrawals(user1Address, token1Address)).to.equal(amount);
    });

    it("refuse une deuxième demande tant qu'une est en attente", async function () {
      await vault.connect(user1).requestWithdraw(token1Address, 1n);
      await expect(vault.connect(user1).requestWithdraw(token1Address, 2n))
        .to.be.revertedWith("DarkPoolVault: Withdrawal already pending");
    });

    it("executeWithdraw paie, débite le solde chiffré et consomme la demande", async function () {
      const amount = ethers.parseEther("4");
      await vault.connect(user1).requestWithdraw(token1Address, amount);

      await expect(vault.connect(enclaveSigner).executeWithdraw(user1Address, token1Address, amount))
        .to.emit(vault, "Withdrawal")
        .withArgs(user1Address, token1Address, amount);

      expect(await decryptedBalance("availableBalanceOf", user1Address, token1Address)).to.equal(deposited - amount);
      expect(await vault.pendingWithdrawals(user1Address, token1Address)).to.equal(0n);
    });

    it("ANTI-DOUBLE-PAIEMENT : rejoue executeWithdraw -> revert", async function () {
      const amount = ethers.parseEther("4");
      await vault.connect(user1).requestWithdraw(token1Address, amount);
      await vault.connect(enclaveSigner).executeWithdraw(user1Address, token1Address, amount);

      await expect(vault.connect(enclaveSigner).executeWithdraw(user1Address, token1Address, amount))
        .to.be.revertedWith("DarkPoolVault: No matching pending request");
    });

    it("executeWithdraw refuse un montant différent de la demande", async function () {
      await vault.connect(user1).requestWithdraw(token1Address, ethers.parseEther("4"));
      await expect(
        vault.connect(enclaveSigner).executeWithdraw(user1Address, token1Address, ethers.parseEther("5"))
      ).to.be.revertedWith("DarkPoolVault: No matching pending request");
    });

    it("executeWithdraw est réservé à l'enclave", async function () {
      await vault.connect(user1).requestWithdraw(token1Address, 1n);
      await expect(vault.connect(user1).executeWithdraw(user1Address, token1Address, 1n))
        .to.be.revertedWith("DarkPoolVault: Not enclave");
    });

    it("rejectWithdraw libère la demande et émet l'événement", async function () {
      const amount = ethers.parseEther("4");
      await vault.connect(user1).requestWithdraw(token1Address, amount);

      await expect(vault.connect(enclaveSigner).rejectWithdraw(user1Address, token1Address))
        .to.emit(vault, "WithdrawRejected")
        .withArgs(user1Address, token1Address, amount);

      expect(await vault.pendingWithdrawals(user1Address, token1Address)).to.equal(0n);
      // l'utilisateur peut re-demander
      await vault.connect(user1).requestWithdraw(token1Address, 1n);
    });

    it("cancelWithdrawRequest permet à l'utilisateur d'annuler sa demande", async function () {
      await vault.connect(user1).requestWithdraw(token1Address, 1n);
      await vault.connect(user1).cancelWithdrawRequest(token1Address);
      expect(await vault.pendingWithdrawals(user1Address, token1Address)).to.equal(0n);
      await vault.connect(user1).requestWithdraw(token1Address, 2n);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  describe("Soumission d'ordres (solvabilité chiffrée + séquestre)", function () {
    const deposited = ethers.parseEther("10");

    beforeEach(async function () {
      await token1.connect(user1).approve(vaultAddress, deposited);
      await vault.connect(user1).deposit(token1Address, deposited);
    });

    it("rejette tokenIn == tokenOut", async function () {
      await expect(submitOrder(user1, token1Address, token1Address, 1n, 1n))
        .to.be.revertedWith("DarkPoolVault: Identical tokens");
    });

    it("ordre SOLVABLE : verdict ok=1, montant séquestré, solde disponible réduit", async function () {
      const amountIn = ethers.parseEther("4");
      await expect(submitOrder(user1, token1Address, token2Address, amountIn, 123n))
        .to.emit(vault, "OrderSubmitted");

      const order = await vault.orders(0);
      expect(order.owner).to.equal(user1Address);
      expect(order.isSettled).to.be.false;
      expect(await mock.getValue(order.solvencyOk)).to.equal(1n);       // verdict chiffré : solvable
      expect(await mock.getValue(order.lockedAmount)).to.equal(amountIn); // séquestre = amountIn

      expect(await decryptedBalance("availableBalanceOf", user1Address, token1Address)).to.equal(deposited - amountIn);
      expect(await decryptedBalance("lockedBalanceOf", user1Address, token1Address)).to.equal(amountIn);
    });

    it("ordre INSOLVABLE : verdict ok=0, séquestre nul, soldes inchangés", async function () {
      const tooMuch = ethers.parseEther("99");
      await submitOrder(user1, token1Address, token2Address, tooMuch, 123n);

      const order = await vault.orders(0);
      expect(await mock.getValue(order.solvencyOk)).to.equal(0n);   // verdict chiffré : insolvable
      expect(await mock.getValue(order.lockedAmount)).to.equal(0n); // rien n'est séquestré

      expect(await decryptedBalance("availableBalanceOf", user1Address, token1Address)).to.equal(deposited);
      expect(await decryptedBalance("lockedBalanceOf", user1Address, token1Address)).to.equal(0n);
    });

    it("cancelOrder déséquestre les fonds", async function () {
      const amountIn = ethers.parseEther("4");
      await submitOrder(user1, token1Address, token2Address, amountIn, 123n);

      await expect(vault.connect(user1).cancelOrder(0))
        .to.emit(vault, "OrderCancelled")
        .withArgs(0, user1Address);

      expect(await decryptedBalance("availableBalanceOf", user1Address, token1Address)).to.equal(deposited);
      expect(await decryptedBalance("lockedBalanceOf", user1Address, token1Address)).to.equal(0n);
      expect((await vault.orders(0)).isSettled).to.be.true;
    });

    it("cancelOrder est réservé au propriétaire et non rejouable", async function () {
      await submitOrder(user1, token1Address, token2Address, 1n, 1n);
      await expect(vault.connect(user2).cancelOrder(0)).to.be.revertedWith("DarkPoolVault: Not order owner");
      await vault.connect(user1).cancelOrder(0);
      await expect(vault.connect(user1).cancelOrder(0)).to.be.revertedWith("DarkPoolVault: Order already settled");
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  describe("Règlement confidentiel (settleMatches v3)", function () {
    const amount1 = ethers.parseEther("10");      // user1 vend 10 token1
    const amount2 = ethers.parseEther("30000");   // user2 vend 30000 token2

    beforeEach(async function () {
      await token1.connect(user1).approve(vaultAddress, amount1);
      await vault.connect(user1).deposit(token1Address, amount1);
      await token2.connect(user2).approve(vaultAddress, amount2);
      await vault.connect(user2).deposit(token2Address, amount2);

      // ordre #0 : user1 vend token1 ; ordre #1 : user2 vend token2 (sens opposés)
      await submitOrder(user1, token1Address, token2Address, amount1, amount2);
      await submitOrder(user2, token2Address, token1Address, amount2, amount1);
    });

    it("règle un match signé par l'enclave SANS révéler de montants", async function () {
      const a1To2Handle = await makeAmountHandle(amount1);
      const a2To1Handle = await makeAmountHandle(amount2);
      const salt = 42n;
      const matchesArray = [
        [0n, 1n, a1To2Handle, "0x00", a2To1Handle, "0x00", true, true, salt]
      ];
      const signature = await signMatches(enclaveSigner, matchesArray);

      // MatchSettled ne contient que ids/users/tokens — aucun montant
      await expect(vault.settleMatches(matchesArray, signature))
        .to.emit(vault, "MatchSettled")
        .withArgs(0, 1, user1Address, user2Address, token1Address, token2Address);

      // Les séquestres chiffrés ont été échangés
      expect(await decryptedBalance("availableBalanceOf", user1Address, token2Address)).to.equal(amount2);
      expect(await decryptedBalance("availableBalanceOf", user2Address, token1Address)).to.equal(amount1);
      expect(await decryptedBalance("lockedBalanceOf", user1Address, token1Address)).to.equal(0n);
      expect(await decryptedBalance("lockedBalanceOf", user2Address, token2Address)).to.equal(0n);

      expect((await vault.orders(0)).isSettled).to.be.true;
      expect((await vault.orders(1)).isSettled).to.be.true;
    });

    it("règle un match PARTIEL confidentiel et met à jour les restes", async function () {
      const execAmount1 = ethers.parseEther("4");      // 4 token1 exécutés
      const execAmount2 = ethers.parseEther("12000");   // 12000 token2 exécutés
      const a1To2Handle = await makeAmountHandle(execAmount1);
      const a2To1Handle = await makeAmountHandle(execAmount2);

      const salt = 55n;
      const matchesArray = [
        [0n, 1n, a1To2Handle, "0x00", a2To1Handle, "0x00", false, false, salt]
      ];
      const signature = await signMatches(enclaveSigner, matchesArray);

      await expect(vault.settleMatches(matchesArray, signature))
        .to.emit(vault, "MatchSettled")
        .withArgs(0, 1, user1Address, user2Address, token1Address, token2Address);

      // Balances mises à jour avec les montants partiels
      expect(await decryptedBalance("availableBalanceOf", user1Address, token2Address)).to.equal(execAmount2);
      expect(await decryptedBalance("availableBalanceOf", user2Address, token1Address)).to.equal(execAmount1);

      // Balances verrouillées mises à jour (amount - execAmount)
      expect(await decryptedBalance("lockedBalanceOf", user1Address, token1Address)).to.equal(amount1 - execAmount1);
      expect(await decryptedBalance("lockedBalanceOf", user2Address, token2Address)).to.equal(amount2 - execAmount2);

      // Les ordres ne sont pas clos
      expect((await vault.orders(0)).isSettled).to.be.false;
      expect((await vault.orders(1)).isSettled).to.be.false;

      // Le lockedAmount dans l'ordre est mis à jour
      const o1 = await vault.orders(0);
      expect(await mock.getValue(o1.lockedAmount)).to.equal(amount1 - execAmount1);
    });

    it("rejette une signature qui ne provient pas de l'enclave", async function () {
      const a1To2Handle = await makeAmountHandle(amount1);
      const a2To1Handle = await makeAmountHandle(amount2);
      const matchesArray = [
        [0n, 1n, a1To2Handle, "0x00", a2To1Handle, "0x00", true, true, 1n]
      ];
      const badSignature = await signMatches(user1, matchesArray);
      await expect(vault.settleMatches(matchesArray, badSignature))
        .to.be.revertedWith("DarkPoolVault: Invalid enclave signature");
    });

    it("bloque le rejeu d'un match déjà exécuté", async function () {
      const a1To2Handle = await makeAmountHandle(amount1);
      const a2To1Handle = await makeAmountHandle(amount2);
      const matchesArray = [
        [0n, 1n, a1To2Handle, "0x00", a2To1Handle, "0x00", true, true, 7n]
      ];
      const signature = await signMatches(enclaveSigner, matchesArray);
      await vault.settleMatches(matchesArray, signature);
      await expect(vault.settleMatches(matchesArray, signature))
        .to.be.revertedWith("DarkPoolVault: Match already processed");
    });

    it("rejette un match dont les paires de tokens ne sont pas complémentaires", async function () {
      // ordre #2 : user1 vend token1 -> token2 (même sens que #0, incompatible avec lui)
      await submitOrder(user1, token1Address, token2Address, 1n, 1n);
      const a1To2Handle = await makeAmountHandle(1n);
      const a2To1Handle = await makeAmountHandle(1n);
      const matchesArray = [
        [0n, 2n, a1To2Handle, "0x00", a2To1Handle, "0x00", true, true, 9n]
      ];
      const signature = await signMatches(enclaveSigner, matchesArray);
      await expect(vault.settleMatches(matchesArray, signature))
        .to.be.revertedWith("DarkPoolVault: Pair mismatch");
    });

    it("rejette un match référençant un ordre déjà réglé", async function () {
      const a1To2Handle = await makeAmountHandle(amount1);
      const a2To1Handle = await makeAmountHandle(amount2);
      const first = [
        [0n, 1n, a1To2Handle, "0x00", a2To1Handle, "0x00", true, true, 11n]
      ];
      await vault.settleMatches(first, await signMatches(enclaveSigner, first));
      const second = [
        [0n, 1n, a1To2Handle, "0x00", a2To1Handle, "0x00", true, true, 12n]
      ]; // salt différent => passe le rejeu, bloque sur isSettled
      await expect(vault.settleMatches(second, await signMatches(enclaveSigner, second)))
        .to.be.revertedWith("DarkPoolVault: Order1 already settled");
    });

    it("rejette un match référençant un ordre inexistant", async function () {
      const a1To2Handle = await makeAmountHandle(amount1);
      const a2To1Handle = await makeAmountHandle(amount2);
      const matchesArray = [
        [0n, 99n, a1To2Handle, "0x00", a2To1Handle, "0x00", true, true, 13n]
      ];
      const signature = await signMatches(enclaveSigner, matchesArray);
      await expect(vault.settleMatches(matchesArray, signature))
        .to.be.revertedWith("DarkPoolVault: Unknown order");
    });
  });
});

