/**
 * Escapa TODOS os caracteres especiais do MarkdownV2 do Telegram.
 * Referência: https://core.telegram.org/bots/api#markdownv2-style
 *
 * Deve ser usado em QUALQUER string dinâmica antes de enviar com parse_mode: 'MarkdownV2'.
 * Caracteres escapados: _ * [ ] ( ) ~ ` > # + - = | { } . ! \
 */
export function escapeMd(text: string | number | null | undefined): string {
  return String(text ?? '').replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

/**
 * Escapa caracteres especiais de HTML para uso com parse_mode: 'HTML'.
 */
export function escapeHtml(text: string | number | null | undefined): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
