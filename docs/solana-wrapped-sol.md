# SOL vs WSOL у запитах Gateway (Raydium)

## 1. Чому назва пулу ≠ те, що треба писати в запиті

- У більшості Raydium-пулів SOL береться у формі токена `So11111111111111111111111111111111111111112` (тобто **Wrapped SOL**).
- У назві пулу (Dexscreener, Raydium UI) ви побачите суфікс `wSOL`, `WSOL`, `Wrapped SOL` тощо.
- **У Gateway символ цього токена — `SOL`.** Це визначено у файлі `src/templates/tokens/solana/mainnet-beta.json`, де назва «Wrapped Solana», але поле `symbol` дорівнює `SOL`.

Отже, якщо передати `baseToken: "WSOL"` або `quoteToken: "Wrapped SOL"`, сервіс не зможе знайти токен у локальному реєстрі (`Solana.getToken(symbol)` поверне `null`) і `execute-swap` завершиться помилкою `Pool not found`/`Token not found`.

## 2. Як Gateway працює з SOL під капотом

- Коли ви вказуєте `SOL`, сервіс автоматично:
  1. Визначає mint `So11111111111111111111111111111111111111112`.
  2. Для CLMM-свопів передає `ownerInfo.useSOLBalance = true`, тож можна витрачати **нативний** SOL, навіть якщо немає явного WSOL-токена.
  3. Після виконання транзакції Solana сама «загортає»/«розгортає» SOL за потреби.
- Це стосується будь-яких типів свопів, як SELL (ExactIn), так і BUY (ExactOut).

## 3. Коли саме треба писати `SOL`

1. **Якщо в пулі бачите `wSOL`/`Wrapped SOL`.** Незалежно від того, SOL виступає base чи quote токеном, у запиті потрібно вказувати `SOL`.
2. **У `scripts/...` конфігах.** Наприклад, у `scripts/check-solana-price.js` поле `quoteToken` повинно бути `SOL`, навіть якщо у Raydium UI пара підписана як `KITE/WSOL`.
3. **Для балансів.** Ендпоінт `/chains/solana/balances` повертає два рядки: `type: "native"` (SOL) та `type: "base"` (WSOL). Але в API запитах все одно використовуємо `SOL`.

## 4. Як перевірити, що ви використали правильний символ

1. `GET /connectors/raydium/amm/quote-swap?baseToken=SOL&quoteToken=KITE&...` — якщо токен знайдено, ендпоінт поверне котирування.
2. `GET /connectors/raydium/amm/pool-info?poolAddress=...` — переконайтесь, що `baseTokenAddress` або `quoteTokenAddress` дорівнює `So1111...`. Якщо так, символ для API — `SOL`.

## 5. Узагальнення

- **Незалежно від того, як називається пул на сторонньому UI, у Gateway символ SOL завжди `SOL`.**
- **Це правило однакове для BUY і SELL** — воно не залежить від типу ордера.
- Якщо потрібно працювати з альтернативними стейкінг-версіями (mSOL, jitoSOL тощо), використовуйте їх окремі символи (`MSOL`, `JITOSOL`). Вони мають власні записи в token list.

Тримайте цей документ поруч, коли працюєте з парами на кшталт `RAPID-SOL/KITE`: для всіх запитів у полі токена потрібно писати саме `SOL`.
