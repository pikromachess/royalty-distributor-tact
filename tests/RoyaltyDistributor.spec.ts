import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, toNano, Address } from '@ton/core';
import { RoyaltyDistributor } from '../wrappers/RoyaltyDistributor';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';

describe('RoyaltyDistributor', () => {
    let code: Cell;
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let royaltyDistributor: SandboxContract<RoyaltyDistributor>;
    let owner: SandboxContract<TreasuryContract>;
    let nftCollection: SandboxContract<TreasuryContract>;
    let recipient1: SandboxContract<TreasuryContract>;
    let recipient2: SandboxContract<TreasuryContract>;

    const COMMISSION_RATE = 500; // 5%
    const CONFIG_HASH = BigInt('0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef');

    beforeAll(async () => {
        code = await compile('RoyaltyDistributor');
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        deployer = await blockchain.treasury('deployer');
        owner = await blockchain.treasury('owner');
        nftCollection = await blockchain.treasury('nftCollection');
        recipient1 = await blockchain.treasury('recipient1');
        recipient2 = await blockchain.treasury('recipient2');

        royaltyDistributor = blockchain.openContract(
            RoyaltyDistributor.createFromConfig({
                owner: owner.address,
                config_hash: CONFIG_HASH,
                commission_rate: COMMISSION_RATE,
            }, code)
        );

        const deployResult = await royaltyDistributor.sendDeploy(
            deployer.getSender(), 
            toNano('0.05')
        );

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: royaltyDistributor.address,
            deploy: true,
            success: true,
        });
    });

    it('should deploy correctly', async () => {
        const configHash = await royaltyDistributor.getGetConfigHash();
        const commissionRate = await royaltyDistributor.getGetCommissionRate();
        const contractOwner = await royaltyDistributor.getGetOwner();

        expect(configHash).toEqual(CONFIG_HASH);
        expect(commissionRate).toEqual(BigInt(COMMISSION_RATE));
        expect(contractOwner).toEqualAddress(owner.address);
    });

    it('should receive royalty payment and accumulate commission', async () => {
        const royaltyAmount = toNano('1'); // 1 TON
        const expectedCommission = (royaltyAmount * BigInt(COMMISSION_RATE)) / 10000n;
        const expectedDistributable = royaltyAmount - expectedCommission;

        const result = await royaltyDistributor.sendRoyaltyPayment(
            nftCollection.getSender(),
            {
                value: royaltyAmount + toNano('0.02'), // +gas
                query_id: BigInt(Date.now()),
                collection: nftCollection.address,
                amount: royaltyAmount,
            }
        );

        expect(result.transactions).toHaveTransaction({
            from: nftCollection.address,
            to: royaltyDistributor.address,
            success: true,
        });

        const accumulatedCommission = await royaltyDistributor.getGetAccumulatedCommission();
        const pendingDistribution = await royaltyDistributor.getGetPendingDistribution(nftCollection.address);

        expect(accumulatedCommission).toEqual(expectedCommission);
        expect(pendingDistribution).toEqual(expectedDistributable);
    });

    it('should allow owner to update config hash', async () => {
        const newConfigHash = BigInt('0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890');

        const result = await royaltyDistributor.sendUpdateConfigHash(
            owner.getSender(),
            {
                value: toNano('0.01'),
                query_id: BigInt(Date.now()),
                new_hash: newConfigHash,
            }
        );

        expect(result.transactions).toHaveTransaction({
            from: owner.address,
            to: royaltyDistributor.address,
            success: true,
        });

        const configHash = await royaltyDistributor.getGetConfigHash();
        expect(configHash).toEqual(newConfigHash);
    });

    it('should not allow non-owner to update config hash', async () => {
        const newConfigHash = BigInt('0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890');

        const result = await royaltyDistributor.sendUpdateConfigHash(
            deployer.getSender(), // Not the owner
            {
                value: toNano('0.01'),
                query_id: BigInt(Date.now()),
                new_hash: newConfigHash,
            }
        );

        expect(result.transactions).toHaveTransaction({
            from: deployer.address,
            to: royaltyDistributor.address,
            success: false,
        });
    });

    it('should allow owner to withdraw commission', async () => {
        // First, accumulate some commission
        const royaltyAmount = toNano('2');
        await royaltyDistributor.sendRoyaltyPayment(
            nftCollection.getSender(),
            {
                value: royaltyAmount + toNano('0.02'),
                query_id: BigInt(Date.now()),
                collection: nftCollection.address,
                amount: royaltyAmount,
            }
        );

        const accumulatedCommission = await royaltyDistributor.getGetAccumulatedCommission();
        const withdrawAmount = accumulatedCommission;

        const result = await royaltyDistributor.sendWithdrawCommission(
            owner.getSender(),
            {
                value: toNano('0.05'),
                query_id: BigInt(Date.now()),
                amount: withdrawAmount,
            }
        );

        expect(result.transactions).toHaveTransaction({
            from: owner.address,
            to: royaltyDistributor.address,
            success: true,
        });

        expect(result.transactions).toHaveTransaction({
            from: royaltyDistributor.address,
            to: owner.address,
            value: withdrawAmount,
        });

        const remainingCommission = await royaltyDistributor.getGetAccumulatedCommission();
        expect(remainingCommission).toEqual(0n);
    });

    it('should distribute royalty to multiple recipients', async () => {
        // First, send royalty payment
        const royaltyAmount = toNano('1');
        await royaltyDistributor.sendRoyaltyPayment(
            nftCollection.getSender(),
            {
                value: royaltyAmount + toNano('0.02'),
                query_id: BigInt(Date.now()),
                collection: nftCollection.address,
                amount: royaltyAmount,
            }
        );

        const pendingAmount = await royaltyDistributor.getGetPendingDistribution(nftCollection.address);
        const amount1 = pendingAmount * 60n / 100n; // 60%
        const amount2 = pendingAmount * 40n / 100n; // 40%

        // Create distribution map
        const recipients = new Map<Address, bigint>();
        recipients.set(recipient1.address, amount1);
        recipients.set(recipient2.address, amount2);

        const result = await royaltyDistributor.sendDistributeRoyalty(
            deployer.getSender(), // Anyone can trigger distribution
            {
                value: toNano('0.2'), // Sufficient gas for distribution
                query_id: BigInt(Date.now()),
                collection: nftCollection.address,
                recipients: recipients,
            }
        );

        expect(result.transactions).toHaveTransaction({
            from: deployer.address,
            to: royaltyDistributor.address,
            success: true,
        });

        // Check that recipients received their amounts
        expect(result.transactions).toHaveTransaction({
            from: royaltyDistributor.address,
            to: recipient1.address,
            value: amount1,
        });

        expect(result.transactions).toHaveTransaction({
            from: royaltyDistributor.address,
            to: recipient2.address,
            value: amount2,
        });

        // Check pending distribution is cleared
        const remainingPending = await royaltyDistributor.getGetPendingDistribution(nftCollection.address);
        expect(remainingPending).toEqual(0n);
    });

    it('should reject royalty payment with zero amount', async () => {
        const result = await royaltyDistributor.sendRoyaltyPayment(
            nftCollection.getSender(),
            {
                value: toNano('0.02'),
                query_id: BigInt(Date.now()),
                collection: nftCollection.address,
                amount: 0n,
            }
        );

        expect(result.transactions).toHaveTransaction({
            from: nftCollection.address,
            to: royaltyDistributor.address,
            success: false,
        });
    });

    it('should handle multiple royalty payments for same collection', async () => {
        const payment1 = toNano('0.5');
        const payment2 = toNano('1.0');
        const payment3 = toNano('0.8');

        const expectedCommission1 = (payment1 * BigInt(COMMISSION_RATE)) / 10000n;
        const expectedCommission2 = (payment2 * BigInt(COMMISSION_RATE)) / 10000n;
        const expectedCommission3 = (payment3 * BigInt(COMMISSION_RATE)) / 10000n;
        const totalExpectedCommission = expectedCommission1 + expectedCommission2 + expectedCommission3;

        const expectedDistributable1 = payment1 - expectedCommission1;
        const expectedDistributable2 = payment2 - expectedCommission2;
        const expectedDistributable3 = payment3 - expectedCommission3;
        const totalExpectedDistributable = expectedDistributable1 + expectedDistributable2 + expectedDistributable3;

        // Send multiple payments
        await royaltyDistributor.sendRoyaltyPayment(nftCollection.getSender(), {
            value: payment1 + toNano('0.02'),
            query_id: BigInt(Date.now()),
            collection: nftCollection.address,
            amount: payment1,
        });

        await royaltyDistributor.sendRoyaltyPayment(nftCollection.getSender(), {
            value: payment2 + toNano('0.02'),
            query_id: BigInt(Date.now() + 1),
            collection: nftCollection.address,
            amount: payment2,
        });

        await royaltyDistributor.sendRoyaltyPayment(nftCollection.getSender(), {
            value: payment3 + toNano('0.02'),
            query_id: BigInt(Date.now() + 2),
            collection: nftCollection.address,
            amount: payment3,
        });

        const accumulatedCommission = await royaltyDistributor.getGetAccumulatedCommission();
        const pendingDistribution = await royaltyDistributor.getGetPendingDistribution(nftCollection.address);

        expect(accumulatedCommission).toEqual(totalExpectedCommission);
        expect(pendingDistribution).toEqual(totalExpectedDistributable);
    });

    it('should reject distribution without sufficient gas', async () => {
        // Send royalty payment first
        await royaltyDistributor.sendRoyaltyPayment(nftCollection.getSender(), {
            value: toNano('1.02'),
            query_id: BigInt(Date.now()),
            collection: nftCollection.address,
            amount: toNano('1'),
        });

        const recipients = new Map<Address, bigint>();
        recipients.set(recipient1.address, toNano('0.5'));

        const result = await royaltyDistributor.sendDistributeRoyalty(
            deployer.getSender(),
            {
                value: toNano('0.05'), // Insufficient gas
                query_id: BigInt(Date.now()),
                collection: nftCollection.address,
                recipients: recipients,
            }
        );

        expect(result.transactions).toHaveTransaction({
            from: deployer.address,
            to: royaltyDistributor.address,
            success: false,
        });
    });

    it('should track seqno correctly', async () => {
        const initialSeqno = await royaltyDistributor.getGetSeqno();
        expect(initialSeqno).toEqual(0n);

        // Send royalty payment
        await royaltyDistributor.sendRoyaltyPayment(nftCollection.getSender(), {
            value: toNano('1.02'),
            query_id: BigInt(Date.now()),
            collection: nftCollection.address,
            amount: toNano('1'),
        });

        const seqnoAfterPayment = await royaltyDistributor.getGetSeqno();
        expect(seqnoAfterPayment).toEqual(1n);

        // Update config
        await royaltyDistributor.sendUpdateConfigHash(owner.getSender(), {
            value: toNano('0.01'),
            query_id: BigInt(Date.now()),
            new_hash: BigInt('0x123456'),
        });

        const seqnoAfterUpdate = await royaltyDistributor.getGetSeqno();
        expect(seqnoAfterUpdate).toEqual(2n);
    });
});