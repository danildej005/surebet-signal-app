# HANDOFF — Surebet Signal

> Состояние проекта + «продолжи с этого места». Читать при старте новой сессии или после
> сжатия контекста. Секретов тут НЕТ (токен/прокси-пароли хранятся в приложении шифрованно).

Репозиторий: **github.com/danildej005/surebet-signal-app** (публичный).
Текущая версия: **0.7.4**. Релизы собираются вручную с Mac, публикуются в GitHub Releases.

---

## Что это
Windows-приложение (Electron) для вилок:
1. следит за вилками на surebet.com (через окно сайта) и шлёт сигналы с **Pinnacle** в Telegram;
2. встроенный **антидетект-браузер** контор (Betano, Pinnacle): своя сессия + прокси + отпечаток + гео на контору;
3. клик по плечу вилки → открывает нужную контору **сразу на событии**;
4. **dry-run купона**: вписывает сумму и находит кнопку постановки (пока без боевого клика).

## Готово (фазы)
- ✅ Сигналы surebet→Telegram (фильтр: есть плечо Pinnacle). Telegram через прокси (Cloudflare worker или http/socks).
- ✅ Авто-восстановление застрявшего автообновления surebet, watchdog сессии.
- ✅ Антидетект-окна контор: сессия `persist:booker-<id>`, прокси, отпечаток (UA/таймзона/локаль/гео/WebGL/canvas), WebRTC-защита.
- ✅ Фаза 4: клик по плечу → разбор surebet-nav → нужная контора на событии.
- ✅ Фаза 5 (Pinnacle + Betano): dry-run + **авто-выбор исхода** общей функцией `pickOutcome` — по id из вилки ИЛИ по описанию `tr_terse` (фора/тотал/победа) + ближайшему кэфу. Селектор исходов на контору в `BETSLIP[id].outcomeSel` (Pinnacle `[id*="|"]`, Betano `.selections__selection`); клик по **индексу** (у Betano исходов нет id). → клик исхода → **сверка кэфа** (`ODDS_TOLERANCE`=5%) → ввод суммы (React value-tracker). Тумблер **`liveMode`** (выкл по умолч.) + кнопка «ПОСТАВИТЬ». `pendingBet` пишется с клика по плечу. Тесты на реальных кнопках обеих контор: `test/pickOutcome.test.cjs` (14).

## Дальше (роадмап)
1. **Кнопка «Запуск бота»** — оркестратор полного цикла: вилка → оба плеча → события → купоны → суммы → (под liveMode) ставка. Ядро на одном плече готово (`placeBet`), нужно связать оба плеча одной вилки.
2. **Расчёт сумм плеч** (балансировка арбитража) — пока сумма вводится вручную.
3. **Боевой клик (live) — проверить на копеечной ставке** на одном плече, прежде чем оркестрировать оба (реальные деньги — действие пользователя через тумблер).
4. Автологин контор (поля login/pass уже есть; CAPTCHA/2FA — fallback ручной). Низкий приоритет (сессия и так держится).
5. Победа (`П1/П2`) выбирается по ближайшему кэфу среди «простых» кнопок — при странных рынках уточнить (сейчас фора/тотал надёжнее всего).

---

## Архитектура (файлы)
- `main.cjs` — главный процесс: окно surebet (watcher), окна контор (антидетект), трей, авто-обновление, IPC.
- `preload-control.cjs` / `preload-surebet.cjs` — мосты.
- `renderer/` — панель (index.html / app.js / styles.css).
- `lib/parse.cjs` — парсер вилок surebet (tbody.surebet_record, data-testid).
- `lib/filter.cjs`, `lib/format.cjs`, `lib/dedupe.cjs` — фильтр Pinnacle, текст сигнала, антиспам.
- `lib/surebetReader.cjs` — чтение DOM окна surebet (включает автообновление, спуф видимости).
- `lib/bookers.cjs` — профили контор, отпечаток (`buildFingerprintScript`), `buildProxyString`, разбор surebet-nav (`parseSurebetNav`/`resolveSurebetNav`), `bookerForUrl`.
- `lib/proxyBridge.cjs` — локальный HTTP→SOCKS5 мост (для авторизованного SOCKS5).
- `lib/settings.cjs` — настройки в userData, шифрование safeStorage.
- `lib/logger.cjs` — `logs/main.log` (ловит краши, события).

## Ключевые технические нюансы (грабли, на которых уже наступили)
- **CDP-отпечаток зависает**, если слать команды до готовности рендерера → сначала `loadURL("about:blank")`, потом CDP, потом сайт (иначе loadURL не вызывается = белый экран).
- **Авторизация HTTP/HTTPS-прокси** — событие `login` ловить на **`win.webContents.on("login")`**, НЕ на session (иначе 407 → ERR_TUNNEL_CONNECTION_FAILED −111).
- **Авторизованный SOCKS5** Chromium не умеет → локальный мост (`lib/proxyBridge.cjs`), сессия указывает на `http://127.0.0.1:<port>`.
- **Закрытие окна конторы** роняло процесс → на `win.on("close")` отцеплять `webContents.debugger.detach()`.
- **React-инпуты** (купоны): вписывать через нативный setter + `_valueTracker.setValue(old)` + dispatch input/change, и читать результат после паузы (~800мс).
- **Pinnacle SPA** рендерится ~10с — окно сперва пустое, это не баг.
- **«Логин surebet при клике по плечу Pinnacle» — НАСТОЯЩАЯ причина (0.7.2, доказано логом):** surebet шлёт плечо Pinnacle под брендом **`ps3838`** (а не `pinnaclesports`). Раньше таблица `BK_TO_BOOKER` его не знала → `booker=null` → срабатывал запасной путь `bookerForUrl(url)`, а в surebet-nav URL лежат **оба** плеча → совпадало слово «betano» → ссылка `su.surebet.com/...` грузилась в **окно Betano** (там нет surebet-сессии) → **логин surebet**. Фиксы: (1) `bkToBookerId(bk)` — сопоставление по ПОДСТРОКЕ (`pinnacle|ps3838`→pinnacle, `betano`→betano), а не по точному ключу; (2) для surebet-nav с нераспознанным bk **НЕ падать в `bookerForUrl`** (return deny), иначе misroute по слову в URL. Регресс-тест в `test/bookers.test.cjs`.
- **`resolveEventViaNav` (surebet-проход) — ТОЛЬКО когда у конторы нет глубокой ссылки** (Betano = только домен). Для Pinnacle глубокая ссылка уже в `markers.link` → проход пропускается (`new URL(initial).pathname` длиннее «/»). Проход идёт в **скрытом** окне на surebet-сессии — сам по себе логин surebet пользователю НЕ показывает (мой диагноз в 0.7.1 был ошибочным — настоящая причина была в bk-мэппинге выше).
- **Отчёт о версии**: первая строка `main.log` старая; смотреть последнюю `=== старт ... ===`.

## Разметка купонов (фаза 5)
- **Pinnacle:** сумма `input[name="stake"]`; кнопка содержит «CONFIRM» + «SINGLE BET» (счётчик N = индикатор регистрации суммы); исход — кнопка `[id="eventId|период|тип|сторона|x|линия"]`, выбранный класс `selected`. Из вилки id берём из `markers.pinnacleBrExternalId`.
- **Betano:** сумма `input[id^="stakeInput"]`; кнопка «BET NOW»; исходы — `.selections__selection` (текст «Team/Over/Under <линия> <кэф>», без id).
- **surebet-nav** (ссылка плеча): `https://su.surebet.com/nav/surebet/prong/{N}/.../if?json_body={...}`. `prong/N` = индекс плеча. `json_body.prongs[N]` (строка→JSON) даёт `bk`, `markers.link` (глубокая ссылка), `markers.pinnacleBrExternalId`, `value` (кэф), `tr_terse` (тип ставки). Betano глубокой ссылки в данных не отдаёт → дохождение через `resolveEventViaNav` (скрытое окно на surebet-сессии ловит финальный URL конторы).
- **Бренд `ps3838` (Pinnacle) присылает минимальные markers** — НЕТ `markers.link` и НЕТ `pinnacleBrExternalId` (только событие через redirect + `tr_terse` + кэф). Поэтому выбор исхода по id невозможен → выбираем по описанию+кэфу (`pickPinnacleOutcome`). Кнопки исходов на странице: `<button>` с `id="eventId|период|тип|сторона|x|линия"` и текстом «`+1.5 1.543`»/«`Over 2.5 Sets 2.550`»/«`Имя 1.709`». Тип в id: 1=победа, 2=фора, 3=тотал. Две кнопки одной форы (+1.5 у обоих игроков) разводятся по кэфу.

## Релиз (как собирать/публиковать)
```
cd surebet-signal-app
# bump версии в package.json (отдельной командой — длинные && цепочки в этой среде обрываются)
git add -A && git commit -m "..."          # отдельной командой
git push origin main
export GH_TOKEN=$(printf "protocol=https\nhost=github.com\n\n" | git credential fill | sed -n 's/^password=//p')
npm run release                             # electron-builder --win --publish always → создаёт ЧЕРНОВИК релиза
# затем опубликовать черновик (draft:false) через GitHub API PATCH /releases/<id>
```
- `.github/` в **.gitignore** (токен без scope `workflow` → пуш воркфлоу отклоняется). CI не настроен, собираем вручную.
- Сборка Windows идёт **с Mac** (electron-builder, cross-build). Тестирует пользователь на Windows-**VDS**.

## Осторожно
- **Реальные деньги.** Боевую постановку держать за тумблером (ВЫКЛ по умолчанию) + сверка кэфа. Сейчас всё в dry-run.
- Секреты (Telegram-токен, прокси-логины/пароли, логины контор) — в userData приложения (safeStorage), **в git не кладём**.
- Пользователь логинится в контору сам (автологина пока нет). Окно конторы — антидетект (прокси под аккаунт).
