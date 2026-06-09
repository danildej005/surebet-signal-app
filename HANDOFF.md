# HANDOFF — Surebet Signal

> Состояние проекта + «продолжи с этого места». Читать при старте новой сессии или после
> сжатия контекста. Секретов тут НЕТ (токен/прокси-пароли хранятся в приложении шифрованно).

Репозиторий: **github.com/danildej005/surebet-signal-app** (публичный).
Текущая версия: **0.6.2**. Релизы собираются вручную с Mac, публикуются в GitHub Releases.

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
- ✅ Фаза 5 (частично): dry-run — вписывание суммы (React value-tracker) + поиск кнопки. Проверено: Pinnacle «CONFIRM 1 SINGLE BET», Betano «BET NOW».

## Дальше (роадмап)
1. **Авто-выбор исхода** (сейчас кликаем вручную):
   - Pinnacle — по `pinnacleBrExternalId` из вилки; **match по «хвосту» id** (после первого `|`), т.к. префикс-событие в вилке (`brEventId`) ≠ id события в URL/кнопках.
   - Betano — **по тексту** кнопки `.selections__selection` (id у кнопок нет).
2. **Сверка кэфа**: прочитать кэф выбранного исхода, сравнить с ожидаемым из вилки; если уехал > порога → стоп.
3. **Боевой клик** постановки — тумблер «боевой режим» (по умолчанию ВЫКЛ) + порог отклонения кэфа.
4. Автологин контор (поля login/pass уже есть в профиле; логика позже).

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
- **Отчёт о версии**: первая строка `main.log` старая; смотреть последнюю `=== старт ... ===`.

## Разметка купонов (фаза 5)
- **Pinnacle:** сумма `input[name="stake"]`; кнопка содержит «CONFIRM» + «SINGLE BET» (счётчик N = индикатор регистрации суммы); исход — кнопка `[id="eventId|период|тип|сторона|x|линия"]`, выбранный класс `selected`. Из вилки id берём из `markers.pinnacleBrExternalId`.
- **Betano:** сумма `input[id^="stakeInput"]`; кнопка «BET NOW»; исходы — `.selections__selection` (текст «Team/Over/Under <линия> <кэф>», без id).
- **surebet-nav** (ссылка плеча): `https://su.surebet.com/nav/surebet/prong/{N}/.../if?json_body={...}`. `prong/N` = индекс плеча. `json_body.prongs[N]` (строка→JSON) даёт `bk`, `markers.link` (глубокая ссылка), `markers.pinnacleBrExternalId`, `value` (кэф), `tr_terse` (тип ставки). Betano глубокой ссылки в данных не отдаёт → дохождение через `resolveEventViaNav` (скрытое окно на surebet-сессии ловит финальный URL конторы).

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
