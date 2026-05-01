/**
 * Escapa todos os caracteres especiais do MarkdownV2 do Telegram.
 * Deve ser usado em QUALQUER string dinâmica antes de enviar com parse_mode: 'MarkdownV2'.
 */
export function escapeMd(text: string): string {
  return String(text ?? '').replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

/**
 * Escapa caracteres especiais de HTML para uso com parse_mode: 'HTML'.
 */
export function escapeHtml(text: string): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
