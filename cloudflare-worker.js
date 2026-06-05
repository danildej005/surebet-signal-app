// Cloudflare Worker — обратный прокси к Telegram Bot API.
// Нужен, если провайдер режет api.telegram.org: приложение шлёт запросы на твой
// воркер (домен *.workers.dev обычно не блокируется), а он передаёт их в Telegram.
// Токен бота идёт ТОЛЬКО через твой собственный воркер.
//
// Деплой (≈3 минуты):
//   1. dash.cloudflare.com → раздел «Workers & Pages» → «Create» → «Create Worker».
//   2. Назови как угодно → «Deploy» → потом «Edit code».
//   3. Вставь ВЕСЬ этот файл, замени содержимое → «Deploy».
//   4. Скопируй адрес воркера вида https://ИМЯ.ВЛАДЕЛЕЦ.workers.dev
//   5. В приложении вставь его в поле «Telegram API (прокси)» → Сохранить → Тест.

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = "https://api.telegram.org" + url.pathname + url.search;
    const isBodyless = request.method === "GET" || request.method === "HEAD";
    const upstream = await fetch(target, {
      method: request.method,
      headers: { "content-type": request.headers.get("content-type") || "application/json" },
      body: isBodyless ? undefined : await request.arrayBuffer(),
    });
    return new Response(await upstream.arrayBuffer(), {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") || "application/json" },
    });
  },
};
