import { toNano } from '@ton/core';
import { RoyaltyDistributor } from '../wrappers/RoyaltyDistributor';
import { compile, NetworkProvider } from '@ton/blueprint';
import { Address } from '@ton/core';
import crypto from 'crypto';
import fs from 'fs';

export async function run(provider: NetworkProvider) {
    // Загружаем конфигурацию
    const configPath = './royalty-config.json';
    const configData = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(configData);
    
    // Вычисляем хэш конфигурации
    const configString = JSON.stringify(config, null, 0);
    const configHash = crypto.createHash('sha256').update(configString).digest('hex');
    const configHashInt = BigInt('0x' + configHash);
    
    console.log(`Config hash: ${configHash}`);
    console.log(`Commission rate: ${config.commission_rate / 100}%`);
    
    // Получаем адрес владельца (из кошелька деплоера)
    const owner = provider.sender().address!;
    console.log(`Owner address: ${owner}`);
    
    const royaltyDistributor = provider.open(RoyaltyDistributor.createFromConfig({
        owner: owner,
        config_hash: configHashInt,
        commission_rate: config.commission_rate,
    }, await compile('RoyaltyDistributor')));

    await royaltyDistributor.sendDeploy(provider.sender(), toNano('0.05'));

    await provider.waitForDeploy(royaltyDistributor.address);

    console.log('✅ RoyaltyDistributor deployed successfully!');
    console.log(`📄 Contract address: ${royaltyDistributor.address}`);
    console.log(`🔧 Owner: ${owner}`);
    console.log(`💰 Commission rate: ${config.commission_rate / 100}%`);
    console.log(`📋 Config hash: ${configHash}`);
    
    // Проверяем состояние контракта
    const contractConfigHash = await royaltyDistributor.getGetConfigHash();
    const contractCommissionRate = await royaltyDistributor.getGetCommissionRate();
    const contractOwner = await royaltyDistributor.getGetOwner();
    
    console.log('\n📊 Contract state verification:');
    console.log(`Config hash matches: ${contractConfigHash === configHashInt ? '✅' : '❌'}`);
    console.log(`Commission rate matches: ${contractCommissionRate === BigInt(config.commission_rate) ? '✅' : '❌'}`);
    console.log(`Owner matches: ${contractOwner.toString() === owner.toString() ? '✅' : '❌'}`);
    
    // Сохраняем информацию о деплое
    const deployInfo = {
        address: royaltyDistributor.address.toString(),
        owner: owner.toString(),
        config_hash: configHash,
        commission_rate: config.commission_rate,
        deployed_at: new Date().toISOString(),
        network: provider.network(),
    };
    
    fs.writeFileSync('./deploy-info.json', JSON.stringify(deployInfo, null, 2));
    console.log('\n💾 Deploy info saved to deploy-info.json');
}