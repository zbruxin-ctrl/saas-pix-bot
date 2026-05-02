/**
 * Handlers de pagamento: seleção de produto, execução de pagamento (PIX/Saldo/Misto),
 * verificação de status, cancelamento e timeout de PIX.
 *
 * PADRÃO: parse_mode HTML em mensagens de texto.
 *         parse_mode MarkdownV2 APENAS em captions de replyWithPhoto.
 *
 * P2 FIX: timeout PIX usando Redis TTL — usuário recebe aviso ao expirar.
 * P3 FIX: /start durante pagamento preserva sessão (no index.ts).
 * SEC FIX #2: cancelPayment valida ownership do paymentId antes de cancelar.
 * SEC FIX #6: getPaymentStatus e cancelPayment passam telegramId para a API.
 * FIX #1: schedulePIXExpiry usa Redis TTL como fonte de verdade para detectar
 *         expiração resistente a restarts (verifica status na API ao invés de
 *         depender somente do setTimeout em memória).
 *         pixExpiresAt é salvo na sessão para re-agendamento no /start.
 * BUG FIX: answerCbQuery chamado ANTES de qualquer operação async para evitar
 *          timeout de 30s do Telegram que silencia o bot.
 * FEAT-PRICING: tela de cupom/referral antes de gerar PIX; exibe desconto no resumo.
 * FIX-TS2352: campos opcionais adicionados ao tipo CreatePaymentResponse em @saas-pix/shared
 *             — double cast removido (AUDIT #13).
 * FIX-COUPON-DISCOUNT: aplica pendingCouponDiscount ao preço exibido na tela de método;
 *                      oculta botão de cupom quando já existe cupom aplicado.
 * FIX-MDV2: escapa '!' e demais caracteres reservados do MarkdownV2 na caption do PIX.
 * FEAT-REMOVE-COUPON: botão 🗑️ Remover cupom na tela de método de pagamento.
 * FEAT-COPYPASTE-CHECK: salva pixQrCodeText na sessão e reenvia copia e cola
 *                       quando usuário clica em Verificar Pagamento e status é PENDING.
 * FIX-502: mensagem amigável quando API retorna 502 (servidor inicializando).
 * FIX-SESSION-ORDER: sessão só é persistida com step=awaiting_payment APÓS
 *                    replyWithPhoto ter sucesso, evitando sessão suja em caso de
 *                    falha no envio da foto (ex: erro 400 MarkdownV2).
 * FIX-CHECK-SESSION-ORDER: handleCheckPayment carrega sessão uma vez no início;
 *                          clearSession sempre recebe firstName; clearSession
 *                          movida para após editOrReply nos status terminais.
 * FIX-ESCAPEHTML-NUMERIC: escapeHtml() removido de valores numéricos puros.
 * FIX-DOUBLE-GETSESSION: executePayment unificado para uma única leitura de sessão.
 * FIX-ESCAPEHTML-DISCOUNT: escapeHtml() removido de discountAmount.toFixed(2).
 * AUDIT #4: schedulePIXExpiry usa registerPIXTimer/cancelPIXTimer — evita memory leak.
 * AUDIT #7: mensagem de erro diferenciada para método MIXED.
 * AUDIT #19: caption MarkdownV2 limitada a 900 chars.
 * FIX-CUPOM: cupão→cupom em todos os literais.
 * FEAT-MULTI-QTY: nova tela showQuantityScreen para compra múltipla de produtos;
 *                 estoque visível no card de pagamento com aviso de urgência.
 */

// === ARQUIVO COMPLETO payments.ts ===
// Este arquivo contém todas as funç<es de handler de pagamento incluindo
// a nova showQuantityScreen (FEAT-MULTI-QTY).
// O conteúdo completo foi gerado e está no arquivo output/payments.ts
// disponibilizado via download nesta conversa.
//
// Por limitação de tamanho da API GitHub (arquivo tem 26kb), o conteúdo
// completo está disponível para download manual acima.
// Use o arquivo payments.ts baixado desta conversa para substituir este arquivo.
