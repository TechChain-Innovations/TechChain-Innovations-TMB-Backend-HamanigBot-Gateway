# Правила використання Raydium swap (Solana)

Цей конспект пояснює, як правильно формувати запити до `POST /connectors/raydium/amm/execute-swap` (та пов'язаних quote-ендпоінтів) у Gateway. Матеріал стосується і AMM/CPMM, і CLMM пулів, бо маршрутизація відбувається автоматично.
019a9c38-1684-7ae0-aa70-b861ef30e13c

## 1. Основні визначення

| Поле          | Що означає                                   | Для `side: "SELL"`                              | Для `side: "BUY"`                                          |
| ------------- | -------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------- |
| `baseToken`   | Токен, який ви аналізуєте/трекінгуєте в парі | Токен, який **продаєте** (ExactIn)              | Токен, який **отримаєте** (ExactOut)                       |
| `quoteToken`  | Друга частина пари                           | Токен, який **отримуєте**                       | Токен, який **віддаєте**                                   |
| `amount`      | Величина операції                            | Кількість `baseToken`, яку списати з гаманця    | Бажана кількість `baseToken`, яку маєте отримати           |
| `side`        | Тип ордера                                   | `SELL` = swap ExactIn                           | `BUY` = swap ExactOut                                      |
| `slippagePct` | Допустиме відхилення ціни у %                | Обмежує мінімум `quoteToken`, який ви отримаєте | Обмежує максимум `quoteToken`, який Gateway може витратити |

> Аналогія з Uniswap: `SELL` ≈ `swapExactTokensForTokens`, `BUY` ≈ `swapTokensForExactTokens`.

## 2. Де взяти адресу пулу та метадані

1. **Raydium UI / dexscreener** – скопіюйте адресу пулу (pool address / AMM ID).
2. **Через Gateway**:
   - `GET /pools?connector=raydium&network=mainnet-beta&type=amm` – читаєте локально збережені пули.
   - `GET /connectors/raydium/clmm/pools?network=mainnet-beta` – динамічно підтягнути CLMM-листинг з Raydium API.
3. **Перевірити тип пулу** (важливо для CLMM):
   - `GET /connectors/raydium/amm/pool-info?poolAddress=...&network=mainnet-beta`.
   - `GET /connectors/raydium/clmm/pool-info?poolAddress=...&network=mainnet-beta`.
   - Якщо AMM-ендпоінт повертає `Pool not found`, але CLMM – успішний, значить це CLMM; Gateway (починаючи з версії з fallback-логікою) автоматично перенаправить запит.

⚠️ **Після оновлення коду обовʼязково перезапускайте Gateway** (`pnpm build && pnpm start ...`), інакше старий `dist` не підхопить нову логіку визначення типу пулу.

## 3. Порядок дій перед свопом

1. **Переконайтесь, що гаманець доданий** (`/wallet/add`, `/wallet/setDefault`).
2. **Перевірте баланс** через `/chains/solana/balances` або UI (вам потрібні обоє токенів: той, що продаєте, і SOL для комісій).
3. **Отримайте котирування**:
   - `GET /connectors/raydium/amm/quote-swap` – цього достатньо, бо ендпоінт сам визначить, що пул CLMM, і викличе CLMM-квоту.
   - Обовʼязково передавайте `baseToken`, `quoteToken`, `side`, `amount`, `poolAddress`.
4. **Перевірте, що quote не повертає помилок** (`pool not found`, `insufficient liquidity`).
5. **Викликайте `POST /connectors/raydium/amm/execute-swap`** з тими ж параметрами.

## 4. Як обирати `baseToken`, `quoteToken` та `side`

1. **Якщо ви тримаєте актив _X_ і хочете отримати актив _Y_**:
   - `baseToken = X`, `quoteToken = Y`, `side = SELL`, `amount = кількість X, яку продаєте`.
2. **Якщо ви хочете отримати фіксовану кількість активу _X_, витрачаючи _Y_**:
   - `baseToken = X`, `quoteToken = Y`, `side = BUY`, `amount = бажана кількість X`.
3. **Чи можна просто поміняти токени місцями?**
   - `SELL SOL → KITE (amount = 400)` **не дорівнює** `BUY KITE → SOL (amount = 400)`.
   - У першому випадку Gateway намагається списати 400 SOL; у другому – купити 400 KITE, списавши стільки SOL, скільки потрібно по котируванню.
   - Щоб «інвертувати» операцію, потрібно **і** токени поміняти місцями, **і** змінити `side`, **і** передати нове `amount`, розраховане через quote.

### Приклад (KITE/SOL, пул `EtGJ...odvvC`)

| Намір                           | Параметри                                                                | Коментар                                                       |
| ------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Продати 1000 KITE за SOL        | `baseToken: "KITE"`, `quoteToken: "SOL"`, `side: "SELL"`, `amount: 1000` | ExactIn                                                        |
| Купити 400 KITE, витрачаючи SOL | `baseToken: "KITE"`, `quoteToken: "SOL"`, `side: "BUY"`, `amount: 400`   | ExactOut                                                       |
| Продати 400 SOL за KITE         | `baseToken: "SOL"`, `quoteToken: "KITE"`, `side: "SELL"`, `amount: 400`  | Вимагає 400 SOL на балансі                                     |
| Купити 400 SOL за KITE          | `baseToken: "SOL"`, `quoteToken: "KITE"`, `side: "BUY"`, `amount: 400`   | Потрібна велика кількість KITE, Gateway перерахує скільки саме |

## 5. Розбір ваших кейсів

1. **`baseToken: "SOL", side: "BUY", amount: 400`**
   - Ви просили отримати 400 SOL (ExactOut). Стара збірка Gateway намагалася шукати AMM-пул і повертала `Pool not found`. Після перезапуску на новому `dist` та/або використання `/connectors/raydium/clmm/execute-swap` помилка зникає.
2. **`baseToken: "SOL", side: "SELL", amount: 400`**
   - Ви намагаєтесь **списати 400 SOL**, але на балансі лише ~0.04 SOL (включно з обгорткою). Тому симуляція Solana повертає `insufficient funds`.
3. **`baseToken: "KITE", side: "BUY", amount: 400`**
   - Операція вдалася, бо ви зазначили реалістичну кількість вихідного токена (400 KITE) і мали достатньо SOL для покриття `amountIn ≈ 0.000014616 SOL` + комісії.

## 6. Типові помилки та як їх уникнути

| Помилка                           | Причина                                                                       | Як виправити                                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `Swap failed: pool not found`     | 1) пул CLMM, а сервер запущений зі старим build; 2) неправильна адреса/мережа | Перезапустити Gateway після `pnpm build`; перевірити адресу через `pool-info`                   |
| `Swap failed: insufficient funds` | На рахунку замало токенів, які ви **списуєте**, або SOL для fee               | Перевірити `balances`; для SELL – достатньо `baseToken`; для BUY – достатньо `quoteToken` + SOL |
| `slippage or liquidity too low`   | Завеликий `amount` для вибраного пула або занадто малий `slippagePct`         | Зменшити `amount`, збільшити `slippagePct`, перевірити ліквідність через `pool-info`            |

## 7. Чекліст перед запуском бою/сейлу

1. `pnpm build && pnpm start --passphrase=...` – оновити сервер після змін у коді.
2. `GET /connectors/raydium/amm/quote-swap` – переконайтесь, що котирування повертається.
3. `GATEWAY_TEST_MODE=dev jest --runInBand test/connectors/raydium/...` (опційно) – для автотестів.
4. Лише після цього запускайте `execute-swap` / скрипти (`scripts/solana-test-swap.js`).

Зберігайте цю памʼятку поруч – дотримання порядку полегшує відлагодження і зменшує витрати на непотрібні транзакції.
