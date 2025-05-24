import { Address, TonClient, WalletContractV4, internal } from "@ton/ton";
import { mnemonicToWalletKey } from "@ton/crypto";
import { RoyaltyDistributor } from "./build/RoyaltyDistributor/RoyaltyDistributor";
import fs from 'fs';
import crypto from 'crypto';

interface RoyaltyRecipient {
    address: string;
    royalty_percentage: number;
    name: string;
}

interface DistributionConfig {
    collection_address: string;
    recipients: RoyaltyRecipient[];
}

interface RoyaltyConfig {
    version: string;
    updated_at: string;
    commission_rate: number;
    distributions: DistributionConfig[];
}

export class RoyaltyDistributorService {
    private client: TonClient;
    private wallet: WalletContractV4;
    private distributor: RoyaltyDistributor;
    private config: RoyaltyConfig;
    
    constructor(
        client: TonClient,
        wallet: WalletContractV4,
        distributorAddress: Address,
        configPath: string
    ) {
        this.client = client;
        this.wallet = wallet;
        this.distributor = RoyaltyDistributor.fromAddress(distributorAddress);
        this.loadConfig(configPath);
    }
    
    // Загрузка конфигурации из JSON файла
    private loadConfig(configPath: string) {
        try {
            const configData = fs.readFileSync(configPath, 'utf-8');
            this.config = JSON.parse(configData);
            console.log(`Loaded config version: ${this.config.version}`);
        } catch (error) {
            throw new Error(`Failed to load config: ${error}`);
        }
    }
    
    // Вычисление хэша конфигурации
    getConfigHash(): string {
        const configString = JSON.stringify(this.config, null, 0);
        return crypto.createHash('sha256').update(configString).digest('hex');
    }
    
    // Обновление хэша конфигурации в контракте
    async updateConfigHash(seqno: number) {
        const configHash = this.getConfigHash();
        const configHashInt = BigInt('0x' + configHash);
        
        const updateMessage = {
            $$type: 'UpdateConfigHash',
            query_id: BigInt(Date.now()),
            new_hash: configHashInt
        };
        
        await this.distributor.send(
            this.wallet.sender(seqno),
            {
                value: '0.01', // 0.01 TON для газа
            },
            updateMessage
        );
        
        console.log(`Config hash updated: ${configHash}`);
    }
    
    // Поиск конфигурации распределения для коллекции
    findDistributionConfig(collectionAddress: string): DistributionConfig | null {
        return this.config.distributions.find(
            dist => dist.collection_address === collectionAddress
        ) || null;
    }
    
    // Валидация процентов распределения
    validateDistribution(recipients: RoyaltyRecipient[]): boolean {
        const totalPercentage = recipients.reduce(
            (sum, recipient) => sum + recipient.royalty_percentage, 
            0
        );
        return totalPercentage === 10000; // 100%
    }
    
    // Распределение роялти
    async distributeRoyalty(
        collectionAddress: string,
        totalAmount: bigint,
        seqno: number
    ): Promise<boolean> {
        const distributionConfig = this.findDistributionConfig(collectionAddress);
        
        if (!distributionConfig) {
            console.log(`No distribution config found for collection: ${collectionAddress}`);
            return false;
        }
        
        if (!this.validateDistribution(distributionConfig.recipients)) {
            console.error(`Invalid distribution percentages for collection: ${collectionAddress}`);
            return false;
        }
        
        // Вычисляем комиссию
        const commission = (totalAmount * BigInt(this.config.commission_rate)) / 10000n;
        const distributableAmount = totalAmount - commission;
        
        console.log(`Distributing ${distributableAmount} nanoTON among ${distributionConfig.recipients.length} recipients`);
        
        // Отправляем средства каждому получателю
        for (const recipient of distributionConfig.recipients) {
            const recipientAmount = (distributableAmount * BigInt(recipient.royalty_percentage)) / 10000n;
            
            if (recipientAmount > 0) {
                await this.sendToRecipient(
                    Address.parse(recipient.address),
                    recipientAmount,
                    `Royalty from ${collectionAddress}`,
                    seqno++
                );
                
                console.log(`Sent ${recipientAmount} nanoTON to ${recipient.name} (${recipient.address})`);
            }
        }
        
        return true;
    }
    
    // Отправка средств получателю
    private async sendToRecipient(
        recipientAddress: Address,
        amount: bigint,
        comment: string,
        seqno: number
    ) {
        await this.wallet.sendTransfer({
            seqno,
            secretKey: Buffer.alloc(64), // Здесь должен быть настоящий секретный ключ
            messages: [
                internal({
                    to: recipientAddress,
                    value: amount,
                    body: comment,
                    bounce: false,
                })
            ]
        });
    }
    
    // Мониторинг событий контракта
    async monitorRoyaltyEvents() {
        console.log("Starting royalty event monitoring...");
        
        // В реальной реализации здесь будет подписка на события блокчейна
        // и автоматическое распределение при получении RoyaltyReceived события
        
        setInterval(async () => {
            try {
                const contractState = await this.client.getContractState(this.distributor.address);
                // Проверяем новые события и обрабатываем их
            } catch (error) {
                console.error("Error monitoring events:", error);
            }
        }, 10000); // Проверяем каждые 10 секунд
    }
    
    // Получение информации о контракте
    async getContractInfo() {
        const configHash = await this.distributor.getGetConfigHash();
        const commissionRate = await this.distributor.getGetCommissionRate();
        const accumulatedCommission = await this.distributor.getGetAccumulatedCommission();
        const seqno = await this.distributor.getGetSeqno();
        
        return {
            configHash: configHash.toString(16),
            commissionRate: Number(commissionRate),
            accumulatedCommission: accumulatedCommission.toString(),
            seqno: Number(seqno),
            localConfigHash: this.getConfigHash()
        };
    }
}