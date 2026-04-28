// Rota que recebe updates do Telegram via webhook e repassa para o bot processar.
// O Telegram bate nesta rota (POST /telegram-webhook) na API pública.
// A API valida o secret_token e chama bot.handleUpdate() para processar o update.

import { Router, Request, Response } from 'express';
import { bot } from '../../../bot/src/index';
import { env } from '../config/env';

export const telegramRouter = Router();

telegramRouter.post('/', async (req: Request, res: Response) => {
  // Valida o secret_token enviado pelo Telegram no header X-Telegram-Bot-Api-Secret-Token
  const secretToken = req.headers['x-telegram-bot-api-secret-token'];
  if (env.TELEGRAM_BOT_SECRET && secretToken !== env.TELEGRAM_BOT_SECRET) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  try {
    await bot.handleUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    console.error('[telegram-webhook] Erro ao processar update:', err);
    // Sempre responde 200 para o Telegram não retentar o mesmo update
    res.sendStatus(200);
  }
});
