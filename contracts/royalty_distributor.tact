import "@stdlib/deploy";
import "@stdlib/ownable";

// Структуры сообщений для входящих транзакций
message RoyaltyPayment {
    query_id: Int as uint64;
    collection: Address;
    amount: Int as coins;
}

message UpdateConfigHash {
    query_id: Int as uint64;
    new_hash: Int as uint256;
}

message WithdrawCommission {
    query_id: Int as uint64;
    amount: Int as coins;
}

message DistributeRoyalty {
    query_id: Int as uint64;
    collection: Address;
    recipients: map<Address, Int>; // Address -> amount mapping
}

// События для логирования
message RoyaltyReceived {
    collection: Address;
    total_amount: Int as coins;
    commission: Int as coins;
    distributable: Int as coins;
    config_hash: Int as uint256;
}

message ConfigUpdated {
    old_hash: Int as uint256;
    new_hash: Int as uint256;
    seqno: Int as uint32;
}

message RoyaltyDistributed {
    collection: Address;
    total_distributed: Int as coins;
    recipients_count: Int as uint16;
}

contract RoyaltyDistributor with Deployable, Ownable {
    
    // Состояние контракта
    owner: Address;
    config_hash: Int as uint256; // Хэш JSON конфигурации
    commission_rate: Int as uint16; // basis points (0-10000)
    accumulated_commission: Int as coins;
    seqno: Int as uint32;
    pending_distributions: map<Address, Int>; // collection -> pending amount
    
    init(owner: Address, config_hash: Int, commission_rate: Int) {
        self.owner = owner;
        self.config_hash = config_hash;
        self.commission_rate = commission_rate;
        self.accumulated_commission = 0;
        self.seqno = 0;
        self.pending_distributions = emptyMap();
    }
    
    // Получение роялти от NFT коллекции или маркетплейса
    receive(msg: RoyaltyPayment) {
        require(msg.amount > 0, "Amount must be positive");
        require(context().value >= msg.amount + ton("0.01"), "Insufficient value sent");
        
        // Вычисляем комиссию
        let commission: Int = (msg.amount * self.commission_rate) / 10000;
        let distributable_amount: Int = msg.amount - commission;
        
        self.accumulated_commission = self.accumulated_commission + commission;
        
        // Сохраняем сумму для распределения
        let current_pending: Int = self.pending_distributions.get(msg.collection) ?: 0;
        self.pending_distributions.set(msg.collection, current_pending + distributable_amount);
        
        // Отправляем событие о получении роялти
        emit(RoyaltyReceived{
            collection: msg.collection,
            total_amount: msg.amount,
            commission: commission,
            distributable: distributable_amount,
            config_hash: self.config_hash
        }.toCell());
        
        self.seqno = self.seqno + 1;
    }
    
    // Обновление хэша конфигурации (только владелец)
    receive(msg: UpdateConfigHash) {
        self.requireOwner();
        
        let old_hash: Int = self.config_hash;
        self.config_hash = msg.new_hash;
        
        emit(ConfigUpdated{
            old_hash: old_hash,
            new_hash: msg.new_hash,
            seqno: self.seqno
        }.toCell());
        
        self.seqno = self.seqno + 1;
    }
    
    // Вывод накопленной комиссии (только владелец)
    receive(msg: WithdrawCommission) {
        self.requireOwner();
        require(msg.amount <= self.accumulated_commission, "Insufficient commission balance");
        
        self.accumulated_commission = self.accumulated_commission - msg.amount;
        
        send(SendParameters{
            to: self.owner,
            value: msg.amount,
            mode: SendIgnoreErrors,
            body: "Commission withdrawal".asComment()
        });
        
        self.seqno = self.seqno + 1;
    }
    
    // Распределение средств по адресам (вызывается сервисом после верификации)
    receive(msg: DistributeRoyalty) {
        require(context().value >= ton("0.1"), "Insufficient gas for distribution");
        
        let pending_amount: Int = self.pending_distributions.get(msg.collection) ?: 0;
        require(pending_amount > 0, "No pending distribution for this collection");
        
        let total_distributed: Int = 0;
        let recipients_count: Int = 0;
        
        // Распределяем средства по получателям
        foreach(recipient, amount in msg.recipients) {
            if (amount > 0 && amount <= pending_amount) {
                send(SendParameters{
                    to: recipient,
                    value: amount,
                    mode: SendIgnoreErrors,
                    body: "Royalty distribution".asComment()
                });
                total_distributed = total_distributed + amount;
                recipients_count = recipients_count + 1;
            }
        }
        
        // Обновляем pending amount
        let remaining: Int = pending_amount - total_distributed;
        if (remaining > 0) {
            self.pending_distributions.set(msg.collection, remaining);
        } else {
            self.pending_distributions.set(msg.collection, null);
        }
        
        emit(RoyaltyDistributed{
            collection: msg.collection,
            total_distributed: total_distributed,
            recipients_count: recipients_count
        }.toCell());
        
        self.seqno = self.seqno + 1;
    }
    
    // Getter методы
    get fun get_config_hash(): Int {
        return self.config_hash;
    }
    
    get fun get_commission_rate(): Int {
        return self.commission_rate;
    }
    
    get fun get_accumulated_commission(): Int {
        return self.accumulated_commission;
    }
    
    get fun get_seqno(): Int {
        return self.seqno;
    }
    
    get fun get_owner(): Address {
        return self.owner;
    }
    
    get fun get_pending_distribution(collection: Address): Int {
        return self.pending_distributions.get(collection) ?: 0;
    }
    
    get fun get_contract_balance(): Int {
        return myBalance();
    }
}

// События
message RoyaltyReceived {
    collection: Address;
    total_amount: Int as coins;
    commission: Int as coins;
    distributable: Int as coins;
    config_hash: Int as uint256;
}

message ConfigUpdated {
    old_hash: Int as uint256;
    new_hash: Int as uint256;
    seqno: Int as uint32;
}

message RoyaltyDistributed {
    collection: Address;
    total_distributed: Int as coins;
    recipients_count: Int as uint16;
}