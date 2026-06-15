const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * Suite de tests P0.3 / P0.4 — dépôts/retraits 100% confidentiels (ConfidentialToken)
 * et client furtif (meta-transactions relayées).
 *
 * Le MockNoxCompute simule le FHE "en transparent" : transfer/mint/burn atomiques,
 * décryption publique du verdict d'unwrap, etc. — ce qui permet d'asserter toute la
 * logique chiffrée sans KMS ni TEE réels.
 */
describe("P0.3/P0.4 — ConfidentialToken & client furtif", function () {
  let vault, vaultAddress;
  let mock;
  let weth, usdc, cweth, cusdc;
  let wethAddress, usdcAddress, cwethAddress, cusdcAddress;
  let owner, user1, user2, enclaveSigner, relayer;
  let user1Address, user2Address, enclaveAddress;
  let chainId;

  const INITIAL_SUPPLY = ethers.parseEther("1000000");
  const MOCK_NOX_ADDRESS = "0x75C6AF4430cc474b1bb9b8540b7E46D6f8e1C685"; // adresse Hardhat attendue par Nox.sol

  let handleSeed = 1000;
  function newHandle() {
    handleSeed++;
    return ethers.toBeHex((BigInt(handleSeed) << 208n) | (1n << 200n) | BigInt(handleSeed), 32);
  }

  /** Enregistre un montant en clair pour un handle côté mock, comme le ferait le KMS. */
  async function makeAmountHandle(amount) {
    const h = newHandle();
    await mock.setHandleValue(h, amount);
    return h;
  }

  /** Lit la valeur en clair d'un handle (0 si non initialisé). */
  async function valueOf(handle) {
    if (handle === ethers.ZeroHash) return 0n;
    return await mock.getValue(handle);
  }

  async function wrapperBalance(cToken, addr) {
    return valueOf(await cToken.balanceOf(addr));
  }

  async function vaultAvailable(user, token) {
    return valueOf(await vault.availableBalanceOf(user, token));
  }

  function metaDigest(types, values) {
    return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(types, values));
  }

  /** Signature EIP-191 d'un digest meta-tx (comme le client furtif hors-chaîne). */
  async function signMeta(wallet, digest) {
    return wallet.signMessage(ethers.getBytes(digest));
  }

  /** Signe un règlement (orderId1, orderId2, salt) comme l'enclave. */
  async function signMatches(signer, matchesArray) {
    const encodedData = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "address", "tuple(uint256 orderId1, uint256 orderId2, uint256 salt)[]"],
      [chainId, vaultAddress, matchesArray]
    );
    return signer.signMessage(ethers.getBytes(ethers.keccak256(encodedData)));
  }

  beforeEach(async function () {
    [owner, user1, user2, enclaveSigner, relayer] = await ethers.getSigners();
    user1Address = await user1.getAddress();
    user2Address = await user2.getAddress();
    enclaveAddress = await enclaveSigner.getAddress();
    chainId = (await ethers.provider.getNetwork()).chainId;

    const MockNoxCompute = await ethers.getContractFactory("MockNoxCompute");
    const deployedMock = await MockNoxCompute.deploy();
    await deployedMock.waitForDeployment();
    const mockCode = await ethers.provider.getCode(await deployedMock.getAddress());
    await ethers.provider.send("hardhat_setCode", [MOCK_NOX_ADDRESS, mockCode]);
    mock = await ethers.getContractAt("MockNoxCompute", MOCK_NOX_ADDRESS);

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    weth = await MockERC20.deploy("Mock WETH", "mWETH", INITIAL_SUPPLY);
    usdc = await MockERC20.deploy("Mock USDC", "mUSDC", INITIAL_SUPPLY);
    await weth.waitForDeployment();
    await usdc.waitForDeployment();
    wethAddress = await weth.getAddress();
    usdcAddress = await usdc.getAddress();

    const ConfidentialToken = await ethers.getContractFactory("ConfidentialToken");
    cweth = await ConfidentialToken.deploy(wethAddress, "Confidential WETH", "cWETH", 18);
    cusdc = await ConfidentialToken.deploy(usdcAddress, "Confidential USDC", "cUSDC", 18);
    await cweth.waitForDeployment();
    await cusdc.waitForDeployment();
    cwethAddress = await cweth.getAddress();
    cusdcAddress = await cusdc.getAddress();

    const DarkPoolVault = await ethers.getContractFactory("DarkPoolVault");
    vault = await DarkPoolVault.deploy(enclaveAddress);
    await vault.waitForDeployment();
    vaultAddress = await vault.getAddress();

    await weth.transfer(user1Address, ethers.parseEther("100"));
    await usdc.transfer(user2Address, ethers.parseEther("100000"));
  });

  // ════════════════════════════════════════════════════════════════════════
  describe("P0.3 — Wrap / soldes chiffrés", function () {
    it("wrap transfère le sous-jacent et crédite le solde chiffré", async function () {
      const amount = ethers.parseEther("10");
      await weth.connect(user1).approve(cwethAddress, amount);

      await expect(cweth.connect(user1).wrap(amount))
        .to.emit(cweth, "Wrapped")
        .withArgs(user1Address, user1Address, amount);

      expect(await weth.balanceOf(cwethAddress)).to.equal(amount);
      expect(await wrapperBalance(cweth, user1Address)).to.equal(amount);
      expect(await valueOf(await cweth.totalSupplyHandle())).to.equal(amount);
    });

    it("wrapTo crédite directement un tiers (ex: adresse furtive)", async function () {
      const amount = ethers.parseEther("3");
      await weth.connect(user1).approve(cwethAddress, amount);
      await cweth.connect(user1).wrapTo(user2Address, amount);
      expect(await wrapperBalance(cweth, user2Address)).to.equal(amount);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  describe("P0.3 — Transferts confidentiels", function () {
    const wrapped = ethers.parseEther("10");

    beforeEach(async function () {
      await weth.connect(user1).approve(cwethAddress, wrapped);
      await cweth.connect(user1).wrap(wrapped);
    });

    it("transfère un montant chiffré sans révéler de montant dans l'événement", async function () {
      const amount = ethers.parseEther("4");
      const h = await makeAmountHandle(amount);

      await expect(cweth.connect(user1).transferEncrypted(user2Address, h, "0x00"))
        .to.emit(cweth, "ConfidentialTransfer")
        .withArgs(user1Address, user2Address); // aucun montant

      expect(await wrapperBalance(cweth, user1Address)).to.equal(wrapped - amount);
      expect(await wrapperBalance(cweth, user2Address)).to.equal(amount);
    });

    it("solde insuffisant : transfère 0 SANS revert (pas de fuite d'information)", async function () {
      const h = await makeAmountHandle(ethers.parseEther("99"));
      await cweth.connect(user1).transferEncrypted(user2Address, h, "0x00");
      expect(await wrapperBalance(cweth, user1Address)).to.equal(wrapped);
      expect(await wrapperBalance(cweth, user2Address)).to.equal(0n);
    });

    it("operatorTransfer est refusé sans autorisation", async function () {
      const h = await makeAmountHandle(1n);
      await expect(cweth.connect(user2).operatorTransfer(user1Address, user2Address, h))
        .to.be.revertedWith("ConfidentialToken: Not operator");
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  describe("P0.3 — Unwrap en deux temps (preuve de décryption publique)", function () {
    const wrapped = ethers.parseEther("10");

    beforeEach(async function () {
      await weth.connect(user1).approve(cwethAddress, wrapped);
      await cweth.connect(user1).wrap(wrapped);
    });

    it("unwrap couvert : débit chiffré puis paiement à la finalisation", async function () {
      const amount = ethers.parseEther("4");
      await expect(cweth.connect(user1).requestUnwrap(amount)).to.emit(cweth, "UnwrapRequested");

      // Le solde chiffré est déjà débité, le sous-jacent pas encore payé
      expect(await wrapperBalance(cweth, user1Address)).to.equal(wrapped - amount);

      const before = await weth.balanceOf(user1Address);
      // N'importe qui peut finaliser avec la preuve de la gateway (mock : preuve vide)
      await expect(cweth.connect(relayer).finalizeUnwrap(0, "0x00"))
        .to.emit(cweth, "Unwrapped")
        .withArgs(0, user1Address, amount);
      expect((await weth.balanceOf(user1Address)) - before).to.equal(amount);
    });

    it("unwrap NON couvert : rien n'est débité, la finalisation rejette sans payer", async function () {
      const tooMuch = ethers.parseEther("99");
      await cweth.connect(user1).requestUnwrap(tooMuch);

      expect(await wrapperBalance(cweth, user1Address)).to.equal(wrapped); // inchangé

      const before = await weth.balanceOf(user1Address);
      await expect(cweth.finalizeUnwrap(0, "0x00"))
        .to.emit(cweth, "UnwrapRejected")
        .withArgs(0, user1Address, tooMuch);
      expect(await weth.balanceOf(user1Address)).to.equal(before);
    });

    it("ANTI-DOUBLE-PAIEMENT : une finalisation ne peut pas être rejouée", async function () {
      await cweth.connect(user1).requestUnwrap(1n);
      await cweth.finalizeUnwrap(0, "0x00");
      await expect(cweth.finalizeUnwrap(0, "0x00"))
        .to.be.revertedWith("ConfidentialToken: Already finalized");
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  describe("P0.3 — Dépôts/retraits confidentiels du vault", function () {
    const wrapped = ethers.parseEther("10");

    beforeEach(async function () {
      await weth.connect(user1).approve(cwethAddress, wrapped);
      await cweth.connect(user1).wrap(wrapped);
      await cweth.connect(user1).setOperator(vaultAddress, true);
    });

    it("depositConfidential déplace le solde chiffré wrapper -> vault sans montant public", async function () {
      const amount = ethers.parseEther("6");
      const h = await makeAmountHandle(amount);

      await expect(vault.connect(user1).depositConfidential(cwethAddress, h, "0x00"))
        .to.emit(vault, "ConfidentialDeposit")
        .withArgs(user1Address, cwethAddress); // aucun montant

      expect(await wrapperBalance(cweth, user1Address)).to.equal(wrapped - amount);
      expect(await wrapperBalance(cweth, vaultAddress)).to.equal(amount);
      expect(await vaultAvailable(user1Address, cwethAddress)).to.equal(amount);
    });

    it("dépôt insolvable : 0 est déposé, sans revert ni fuite", async function () {
      const h = await makeAmountHandle(ethers.parseEther("99"));
      await vault.connect(user1).depositConfidential(cwethAddress, h, "0x00");
      expect(await wrapperBalance(cweth, user1Address)).to.equal(wrapped);
      expect(await vaultAvailable(user1Address, cwethAddress)).to.equal(0n);
    });

    it("withdrawConfidential est SYNCHRONE : recrédite le wrapper sans enclave ni file", async function () {
      const deposited = ethers.parseEther("6");
      await vault.connect(user1).depositConfidential(cwethAddress, await makeAmountHandle(deposited), "0x00");

      const out = ethers.parseEther("2");
      await expect(vault.connect(user1).withdrawConfidential(cwethAddress, await makeAmountHandle(out), "0x00"))
        .to.emit(vault, "ConfidentialWithdrawal")
        .withArgs(user1Address, cwethAddress);

      expect(await vaultAvailable(user1Address, cwethAddress)).to.equal(deposited - out);
      expect(await wrapperBalance(cweth, user1Address)).to.equal(wrapped - deposited + out);
      expect(await wrapperBalance(cweth, vaultAddress)).to.equal(deposited - out);
    });

    it("retrait > solde disponible : 0 est retiré, sans revert", async function () {
      const deposited = ethers.parseEther("6");
      await vault.connect(user1).depositConfidential(cwethAddress, await makeAmountHandle(deposited), "0x00");

      await vault.connect(user1).withdrawConfidential(cwethAddress, await makeAmountHandle(ethers.parseEther("50")), "0x00");
      expect(await vaultAvailable(user1Address, cwethAddress)).to.equal(deposited);
      expect(await wrapperBalance(cweth, vaultAddress)).to.equal(deposited);
    });

    it("cycle complet confidentiel : wrap -> dépôt -> ordres -> règlement -> retrait -> unwrap", async function () {
      const amount1 = ethers.parseEther("10");     // user1 vend 10 cWETH
      const amount2 = ethers.parseEther("30000");  // user2 vend 30000 cUSDC

      // user2 prépare son côté
      await usdc.connect(user2).approve(cusdcAddress, amount2);
      await cusdc.connect(user2).wrap(amount2);
      await cusdc.connect(user2).setOperator(vaultAddress, true);

      // Dépôts confidentiels
      await vault.connect(user1).depositConfidential(cwethAddress, await makeAmountHandle(amount1), "0x00");
      await vault.connect(user2).depositConfidential(cusdcAddress, await makeAmountHandle(amount2), "0x00");

      // Ordres opposés sur la paire cWETH/cUSDC
      await vault.connect(user1).submitOrder(
        cwethAddress, cusdcAddress,
        await makeAmountHandle(amount1), "0x00",
        await makeAmountHandle(amount2), "0x00"
      );
      await vault.connect(user2).submitOrder(
        cusdcAddress, cwethAddress,
        await makeAmountHandle(amount2), "0x00",
        await makeAmountHandle(amount1), "0x00"
      );

      // Règlement signé par l'enclave
      const matches = [[0n, 1n, 42n]];
      await vault.settleMatches(matches, await signMatches(enclaveSigner, matches));

      expect(await vaultAvailable(user1Address, cusdcAddress)).to.equal(amount2);
      expect(await vaultAvailable(user2Address, cwethAddress)).to.equal(amount1);

      // user1 retire ses cUSDC (synchrone) puis unwrap vers l'ERC-20 public
      await vault.connect(user1).withdrawConfidential(cusdcAddress, await makeAmountHandle(amount2), "0x00");
      expect(await wrapperBalance(cusdc, user1Address)).to.equal(amount2);

      await cusdc.connect(user1).requestUnwrap(amount2);
      await cusdc.finalizeUnwrap(0, "0x00");
      expect(await usdc.balanceOf(user1Address)).to.equal(amount2);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  describe("P0.4 — Client furtif (meta-transactions relayées)", function () {
    let stealth; // wallet furtif : AUCUN ETH, ne paie jamais de gas

    const funding = ethers.parseEther("10");

    beforeEach(async function () {
      stealth = ethers.Wallet.createRandom();

      // user1 wrap puis transfère confidentiellement vers l'adresse furtive
      await weth.connect(user1).approve(cwethAddress, funding);
      await cweth.connect(user1).wrap(funding);
      await cweth.connect(user1).transferEncrypted(stealth.address, await makeAmountHandle(funding), "0x00");
    });

    async function approveVaultOperator() {
      const nonce = await cweth.metaNonces(stealth.address);
      const digest = metaDigest(
        ["uint256", "address", "string", "address", "address", "bool", "uint256"],
        [chainId, cwethAddress, "setOperator", stealth.address, vaultAddress, true, nonce]
      );
      await cweth.connect(relayer).setOperatorWithSig(
        stealth.address, vaultAddress, true, nonce, await signMeta(stealth, digest)
      );
    }

    async function depositFor(amount) {
      const h = await makeAmountHandle(amount);
      const nonce = await vault.metaNonces(stealth.address);
      const digest = metaDigest(
        ["uint256", "address", "string", "address", "address", "bytes32", "uint256"],
        [chainId, vaultAddress, "depositConfidential", stealth.address, cwethAddress, h, nonce]
      );
      return vault.connect(relayer).depositConfidentialFor(
        stealth.address, cwethAddress, h, "0x00", nonce, await signMeta(stealth, digest)
      );
    }

    it("setOperatorWithSig : l'adresse furtive autorise le vault sans gas", async function () {
      await approveVaultOperator();
      expect(await cweth.isOperator(stealth.address, vaultAddress)).to.be.true;
    });

    it("depositConfidentialFor : dépôt relayé crédité à l'adresse furtive", async function () {
      await approveVaultOperator();
      await expect(depositFor(funding))
        .to.emit(vault, "ConfidentialDeposit")
        .withArgs(stealth.address, cwethAddress);
      expect(await vaultAvailable(stealth.address, cwethAddress)).to.equal(funding);
      // l'adresse furtive n'a jamais eu d'ETH
      expect(await ethers.provider.getBalance(stealth.address)).to.equal(0n);
    });

    it("submitOrderFor : ordre relayé appartenant à l'adresse furtive", async function () {
      await approveVaultOperator();
      await depositFor(funding);

      const aIn = await makeAmountHandle(funding);
      const mOut = await makeAmountHandle(ethers.parseEther("30000"));
      const nonce = await vault.metaNonces(stealth.address);
      const digest = metaDigest(
        ["uint256", "address", "string", "address", "address", "address", "bytes32", "bytes32", "uint256"],
        [chainId, vaultAddress, "submitOrder", stealth.address, cwethAddress, cusdcAddress, aIn, mOut, nonce]
      );

      await expect(
        vault.connect(relayer).submitOrderFor(
          stealth.address, cwethAddress, cusdcAddress,
          aIn, "0x00", mOut, "0x00",
          nonce, await signMeta(stealth, digest)
        )
      ).to.emit(vault, "OrderSubmitted");

      const order = await vault.orders(0);
      expect(order.owner).to.equal(stealth.address);
      expect(await mock.getValue(order.solvencyOk)).to.equal(1n);
      expect(await mock.getValue(order.lockedAmount)).to.equal(funding);
    });

    it("withdrawConfidentialFor : retrait relayé vers le solde wrapper furtif", async function () {
      await approveVaultOperator();
      await depositFor(funding);

      const out = ethers.parseEther("4");
      const h = await makeAmountHandle(out);
      const nonce = await vault.metaNonces(stealth.address);
      const digest = metaDigest(
        ["uint256", "address", "string", "address", "address", "bytes32", "uint256"],
        [chainId, vaultAddress, "withdrawConfidential", stealth.address, cwethAddress, h, nonce]
      );
      await vault.connect(relayer).withdrawConfidentialFor(
        stealth.address, cwethAddress, h, "0x00", nonce, await signMeta(stealth, digest)
      );

      expect(await vaultAvailable(stealth.address, cwethAddress)).to.equal(funding - out);
      expect(await wrapperBalance(cweth, stealth.address)).to.equal(out);
    });

    it("transferEncryptedWithSig + requestUnwrapWithSig : sortie de fonds 100% sans gas", async function () {
      // L'adresse furtive renvoie 4 cWETH vers un wallet propre, puis unwrap 6 cWETH, sans ETH
      const clean = ethers.Wallet.createRandom();

      const amount = ethers.parseEther("4");
      const h = await makeAmountHandle(amount);
      let nonce = await cweth.metaNonces(stealth.address);
      let digest = metaDigest(
        ["uint256", "address", "string", "address", "address", "bytes32", "uint256"],
        [chainId, cwethAddress, "transferEncrypted", stealth.address, clean.address, h, nonce]
      );
      await cweth.connect(relayer).transferEncryptedWithSig(
        stealth.address, clean.address, h, "0x00", nonce, await signMeta(stealth, digest)
      );
      expect(await wrapperBalance(cweth, clean.address)).to.equal(amount);

      const rest = funding - amount;
      nonce = await cweth.metaNonces(stealth.address);
      digest = metaDigest(
        ["uint256", "address", "string", "address", "uint256", "uint256"],
        [chainId, cwethAddress, "requestUnwrap", stealth.address, rest, nonce]
      );
      await cweth.connect(relayer).requestUnwrapWithSig(
        stealth.address, rest, nonce, await signMeta(stealth, digest)
      );
      await cweth.connect(relayer).finalizeUnwrap(0, "0x00");
      expect(await weth.balanceOf(stealth.address)).to.equal(rest);
    });

    it("rejette une signature d'un autre wallet", async function () {
      const h = await makeAmountHandle(1n);
      const nonce = await vault.metaNonces(stealth.address);
      const digest = metaDigest(
        ["uint256", "address", "string", "address", "address", "bytes32", "uint256"],
        [chainId, vaultAddress, "depositConfidential", stealth.address, cwethAddress, h, nonce]
      );
      const badSig = await signMeta(ethers.Wallet.createRandom(), digest);
      await expect(
        vault.connect(relayer).depositConfidentialFor(stealth.address, cwethAddress, h, "0x00", nonce, badSig)
      ).to.be.revertedWith("DarkPoolVault: Invalid meta signature");
    });

    it("rejette le rejeu d'une meta-transaction (nonce consommé)", async function () {
      await approveVaultOperator();
      const h = await makeAmountHandle(1n);
      const nonce = await vault.metaNonces(stealth.address);
      const digest = metaDigest(
        ["uint256", "address", "string", "address", "address", "bytes32", "uint256"],
        [chainId, vaultAddress, "depositConfidential", stealth.address, cwethAddress, h, nonce]
      );
      const sig = await signMeta(stealth, digest);
      await vault.connect(relayer).depositConfidentialFor(stealth.address, cwethAddress, h, "0x00", nonce, sig);
      await expect(
        vault.connect(relayer).depositConfidentialFor(stealth.address, cwethAddress, h, "0x00", nonce, sig)
      ).to.be.revertedWith("DarkPoolVault: Bad nonce");
    });

    it("rejette un digest altéré par le relayer (montant substitué)", async function () {
      await approveVaultOperator();
      const h = await makeAmountHandle(1n);
      const nonce = await vault.metaNonces(stealth.address);
      const digest = metaDigest(
        ["uint256", "address", "string", "address", "address", "bytes32", "uint256"],
        [chainId, vaultAddress, "depositConfidential", stealth.address, cwethAddress, h, nonce]
      );
      const sig = await signMeta(stealth, digest);
      const otherHandle = await makeAmountHandle(999n); // le relayer tente un autre handle
      await expect(
        vault.connect(relayer).depositConfidentialFor(stealth.address, cwethAddress, otherHandle, "0x00", nonce, sig)
      ).to.be.revertedWith("DarkPoolVault: Invalid meta signature");
    });

    it("SCÉNARIO E2E FURTIF : trade complet sans que le wallet principal n'apparaisse", async function () {
      // 1. L'adresse furtive (financée en cWETH par un transfert confidentiel) autorise le vault
      await approveVaultOperator();
      // 2. Dépôt relayé
      await depositFor(funding);

      // 3. Ordre relayé : vend 10 cWETH contre >= 30000 cUSDC
      const amount2 = ethers.parseEther("30000");
      const aIn = await makeAmountHandle(funding);
      const mOut = await makeAmountHandle(amount2);
      let nonce = await vault.metaNonces(stealth.address);
      let digest = metaDigest(
        ["uint256", "address", "string", "address", "address", "address", "bytes32", "bytes32", "uint256"],
        [chainId, vaultAddress, "submitOrder", stealth.address, cwethAddress, cusdcAddress, aIn, mOut, nonce]
      );
      await vault.connect(relayer).submitOrderFor(
        stealth.address, cwethAddress, cusdcAddress, aIn, "0x00", mOut, "0x00",
        nonce, await signMeta(stealth, digest)
      );

      // 4. Contrepartie classique (user2 vend 30000 cUSDC)
      await usdc.connect(user2).approve(cusdcAddress, amount2);
      await cusdc.connect(user2).wrap(amount2);
      await cusdc.connect(user2).setOperator(vaultAddress, true);
      await vault.connect(user2).depositConfidential(cusdcAddress, await makeAmountHandle(amount2), "0x00");
      await vault.connect(user2).submitOrder(
        cusdcAddress, cwethAddress,
        await makeAmountHandle(amount2), "0x00",
        await makeAmountHandle(funding), "0x00"
      );

      // 5. Règlement par l'enclave
      const matches = [[0n, 1n, 7n]];
      await vault.settleMatches(matches, await signMatches(enclaveSigner, matches));
      expect(await vaultAvailable(stealth.address, cusdcAddress)).to.equal(amount2);

      // 6. Retrait relayé des cUSDC gagnés
      const h = await makeAmountHandle(amount2);
      nonce = await vault.metaNonces(stealth.address);
      digest = metaDigest(
        ["uint256", "address", "string", "address", "address", "bytes32", "uint256"],
        [chainId, vaultAddress, "withdrawConfidential", stealth.address, cusdcAddress, h, nonce]
      );
      await vault.connect(relayer).withdrawConfidentialFor(
        stealth.address, cusdcAddress, h, "0x00", nonce, await signMeta(stealth, digest)
      );
      expect(await wrapperBalance(cusdc, stealth.address)).to.equal(amount2);

      // L'adresse furtive n'a JAMAIS payé de gas ni détenu d'ETH
      expect(await ethers.provider.getBalance(stealth.address)).to.equal(0n);
    });
  });
});
