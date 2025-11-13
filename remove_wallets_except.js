const https = require('https');
const http = require('http');

// Адреса, яку потрібно залишити
const KEEP_ADDRESS = 'FhsUTyfApJtzMq2x2DtptSPFNKP382aQJiXzTjfs5Sji';

// Базовий URL API
const API_BASE_URL = 'http://localhost:15888';

// Функція для виконання HTTP запиту
function makeRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;

        const req = protocol.request(url, options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    const jsonData = JSON.parse(data);
                    resolve({ status: res.statusCode, data: jsonData });
                } catch (error) {
                    resolve({ status: res.statusCode, data: data });
                }
            });
        });

        req.on('error', (error) => {
            reject(error);
        });

        if (options.body) {
            req.write(options.body);
        }

        req.end();
    });
}

// Функція для отримання всіх гаманців
async function getAllWallets() {
    try {
        console.log('🔍 Отримання списку всіх гаманців...');
        const response = await makeRequest(`${API_BASE_URL}/wallet/?showHardware=false`);

        if (response.status !== 200) {
            throw new Error(`Помилка отримання гаманців: ${response.status}`);
        }

        return response.data;
    } catch (error) {
        console.error('❌ Помилка при отриманні гаманців:', error.message);
        throw error;
    }
}

// Функція для видалення гаманця
async function removeWallet(chain, address) {
    try {
        const postData = JSON.stringify({
            chain: chain,
            address: address
        });

        const options = {
            method: 'DELETE',
            headers: {
                'accept': 'application/json',
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            },
            body: postData
        };

        console.log(`🗑️  Видалення гаманця ${address} (мережа: ${chain})...`);
        const response = await makeRequest(`${API_BASE_URL}/wallet/remove`, options);

        if (response.status !== 200) {
            console.log(`⚠️  Помилка видалення гаманця ${address}: ${response.status} - ${JSON.stringify(response.data)}`);
            return false;
        }

        console.log(`✅ Гаманець ${address} успішно видалено`);
        return true;
    } catch (error) {
        console.error(`❌ Помилка при видаленні гаманця ${address}:`, error.message);
        return false;
    }
}

// Головна функція
async function main() {
    console.log('🚀 Початок очищення гаманців...');
    console.log(`📍 Буде залишено лише гаманець: ${KEEP_ADDRESS}`);
    console.log('');

    try {
        // Отримуємо список всіх гаманців
        const wallets = await getAllWallets();

        let totalWallets = 0;
        let deletedWallets = 0;
        let keptWallets = 0;

        // Обробляємо кожну мережу
        for (const chainData of wallets) {
            const chain = chainData.chain;
            const addresses = chainData.walletAddresses;

            console.log(`\n📋 Мережа: ${chain}`);
            console.log(`🔢 Загальна кількість гаманців: ${addresses.length}`);

            totalWallets += addresses.length;

            // Видаляємо всі гаманці, окрім того, що потрібно залишити
            for (const address of addresses) {
                if (address === KEEP_ADDRESS) {
                    console.log(`💚 Зберігаємо гаманець: ${address}`);
                    keptWallets++;
                } else {
                    const success = await removeWallet(chain, address);
                    if (success) {
                        deletedWallets++;
                    }
                }
            }
        }

        // Виводимо статистику
        console.log('\n' + '='.repeat(50));
        console.log('📊 СТАТИСТИКА ВИДАЛЕННЯ:');
        console.log(`📈 Загальна кількість гаманців: ${totalWallets}`);
        console.log(`✅ Видалено гаманців: ${deletedWallets}`);
        console.log(`💚 Збережено гаманців: ${keptWallets}`);
        console.log(`🎯 Гаманець ${KEEP_ADDRESS} успішно збережено!`);
        console.log('='.repeat(50));

    } catch (error) {
        console.error('❌ Критична помилка:', error.message);
        process.exit(1);
    }
}

// Запускаємо скрипт
main().catch(console.error);