// Serviço de integração com Telegram Bot API
import axios from 'axios';
import { logger } from '../lib/logger';
import { env } from '../config/env';

const TELEGRAM_API = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;

class TelegramService {

  async sendMessage(chatId: string, text: string): Promise<void> {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
    });
  }

  // Envia imagem; se a URL falhar, envia como link de texto
  async sendPhoto(chatId: string, photoUrl: string, caption?: string): Promise<void> {
    try {
      await axios.post(`${TELEGRAM_API}/sendPhoto`, {
        chat_id: chatId,
        photo: photoUrl,
        caption: caption ?? undefined,
        parse_mode: 'Markdown',
      });
    } catch (err) {
      logger.warn(`sendPhoto falhou para ${photoUrl}, enviando como link:`, err);
      const msg = caption ? `${caption}\n📷 ${photoUrl}` : `📷 ${photoUrl}`;
      await this.sendMessage(chatId, msg);
    }
  }

  // Envia vídeo via URL direta (MP4) ou link — Telegram faz player embutido para MP4 direto
  async sendVideo(chatId: string, videoUrl: string, caption?: string): Promise<void> {
    const isDirectMp4 = /\.(mp4)(\?|$)/i.test(videoUrl);

    if (isDirectMp4) {
      try {
        await axios.post(`${TELEGRAM_API}/sendVideo`, {
          chat_id: chatId,
          video: videoUrl,
          caption: caption ?? undefined,
          parse_mode: 'Markdown',
          supports_streaming: true,
        });
        return;
      } catch (err) {
        logger.warn(`sendVideo falhou para ${videoUrl}, enviando como link:`, err);
      }
    }

    // YouTube ou outros — envia como link clicável
    const label = caption ? `${caption}\n` : '';
    const msg = `${label}🎬 [Assistir vídeo](${videoUrl})`;
    await this.sendMessage(chatId, msg);
  }

  async sendPaymentConfirmation(chatId: string, productName: string, amount: number): Promise<void> {
    const msg =
      `✅ *Pagamento confirmado!*\n\n` +
      `📦 *Produto:* ${productName}\n` +
      `💰 *Valor:* R$ ${amount.toFixed(2)}\n\n` +
      `Obrigado pela sua compra! 🙏`;
    await this.sendMessage(chatId, msg);
  }

  async sendDeliveryError(chatId: string): Promise<void> {
    const msg =
      `⚠️ *Problema na entrega*\n\n` +
      `Identificamos um problema ao entregar seu pedido.\n` +
      `Nossa equipe foi notificada e entrará em contato em breve.`;
    await this.sendMessage(chatId, msg);
  }
}

export const telegramService = new TelegramService();
