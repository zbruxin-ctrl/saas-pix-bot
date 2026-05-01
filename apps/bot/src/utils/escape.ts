/**
 * Utilitários de escape de texto para o Telegram.
 * PADRÃO DO PROJETO: parse_mode HTML.
 * escapeHtml() é a função principal — use sempre.
 * escapeMd() mantido apenas para compatibilidade com captions de foto (replyWithPhoto).
 */

/** Escapa caracteres especiais do HTML para uso com parse_mode HTML */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Escapa caracteres especiais do MarkdownV2 — use APENAS em captions de replyWithPhoto */
export function escapeMd(text: string): string {
  return String(text).replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}
