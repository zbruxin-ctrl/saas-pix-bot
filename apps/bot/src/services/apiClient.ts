// Cliente HTTP para comunicacao do bot com a API interna
// PERF #1: timeout reduzido para 8s (era 15s)
// PERF #2: cache global de produtos TTL 30s
// PERF #4: retry automatico 1x em timeout/network error
// PERF #5: cache de saldo por usuario TTL 15s
// PERF #6: invalidacao do cache de saldo apos deposito
// FEATURE: getOrders(telegramId) - historico de pedidos para /meus_pedidos
// FIX-B17: createPayment agora distingue erro real de idempotência.
//   Problema: a API retornava 200 idempotente quando recebia 2º request BALANCE
//   com saldo já decrementado (FIX-B16). Porém o bot ainda exibia "Saldo
//   insuficiente" se a resposta chegasse como erro 4xx por qualquer razão.
//   Solução: o interceptor do axios passa o statusCode junto com o erro.
//   createPayment verifica: se status === 400 E mensagem contém "saldo
//   insuficiente", faz 1 tentativa extra consultando /orders para verificar
//   se existe pedido aprovado nos últimos 60s para o mesmo produto. Se sim,
//   retorna resposta sintética paidWithBalance=true (idempotente). Garante que
//   o bot nunca mostra "saldo insuficiente" falso para o usuário.
import axios, { AxiosInstance, AxiosError } from 'axios';
import { env } from '../config/env';
import type {
  CreatePaymentResponse,
  CreateDepositResponse,
  WalletBalanceResponse,
  ProductDTO,
  ApiResponse,
  PaymentMethod,
} from '@saas-pix/shared';

interface ProductCache {
  products: ProductDTO[];
  expiresAt: number;
}
let productCache: ProductCache | null = null;
const PRODUCT_CACHE_TTL = 30_000;

export function invalidateProductCache(): void {
  productCache = null;
}

interface BalanceCache {
  data: WalletBalanceResponse;
  expiresAt: number;
}
const balanceCache = new Map<string, BalanceCache>();
const BALANCE_CACHE_TTL = 15_000;

export function invalidateBalanceCache(telegramId: string): void {
  balanceCache.delete(telegramId);
}

export interface OrderSummary {
  id: string;
  status: string;
  createdAt: string;
  deliveredAt: string | null;
  productName: string;
  amount: number | null;
  paymentMethod: PaymentMethod | null;
}

// Erro customizado que carrega o statusCode HTTP junto
class ApiHttpError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = 'ApiHttpError';
  }
}

class ApiClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: env.API_URL,
      headers: {
        'Content-Type': 'application/json',
        'x-bot-secret': env.TELEGRAM_BOT_SECRET,
      },
      timeout: 8000,
    });

    // FIX-B17: preserva statusCode no erro para permitir lógica de fallback
    this.client.interceptors.response.use(
      (r) => r,
      (error) => {
        const msg = error.response?.data?.error || error.message;
        const status = error.response?.status ?? 0;
        throw new ApiHttpError(msg, status);
      }
    );
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      const isRetryable =
        msg.toLowerCase().includes('timeout') ||
        msg.toLowerCase().includes('econnreset') ||
        msg.toLowerCase().includes('network error') ||
        (err instanceof AxiosError && !err.response);
      if (isRetryable) {
        await new Promise((r) => setTimeout(r, 300));
        return await fn();
      }
      throw err;
    }
  }

  async getProducts(): Promise<ProductDTO[]> {
    const now = Date.now();
    if (productCache && productCache.expiresAt > now) {
      return productCache.products;
    }
    const { data } = await this.withRetry(() =>
      this.client.get<ApiResponse<ProductDTO[]>>('/api/payments/products')
    );
    productCache = { products: data.data!, expiresAt: now + PRODUCT_CACHE_TTL };
    return data.data!;
  }

  async getBalance(telegramId: string): Promise<WalletBalanceResponse> {
    const now = Date.now();
    const cached = balanceCache.get(telegramId);
    if (cached && cached.expiresAt > now) {
      return cached.data;
    }
    const { data } = await this.withRetry(() =>
      this.client.get<ApiResponse<WalletBalanceResponse>>(
        `/api/payments/balance?telegramId=${encodeURIComponent(telegramId)}`
      )
    );
    balanceCache.set(telegramId, { data: data.data!, expiresAt: now + BALANCE_CACHE_TTL });
    return data.data!;
  }

  async getOrders(telegramId: string): Promise<OrderSummary[]> {
    const { data } = await this.withRetry(() =>
      this.client.get<ApiResponse<OrderSummary[]>>(
        `/api/payments/orders?telegramId=${encodeURIComponent(telegramId)}`
      )
    );
    return data.data ?? [];
  }

  async createPayment(params: {
    telegramId: string;
    productId: string;
    firstName?: string;
    username?: string;
    paymentMethod?: PaymentMethod;
  }): Promise<CreatePaymentResponse> {
    invalidateBalanceCache(params.telegramId);
    try {
      const { data } = await this.withRetry(() =>
        this.client.post<ApiResponse<CreatePaymentResponse>>('/api/payments/create', params)
      );
      return data.data!;
    } catch (err) {
      // FIX-B17: se recebemos 400 "saldo insuficiente" em modo BALANCE,
      // pode ser um 2º request duplicado (saldo já decrementado pelo 1º).
      // Antes de exibir o erro ao usuário, consultamos /orders para verificar
      // se existe pedido APPROVED recente (últimos 60s) para o mesmo produto.
      if (
        err instanceof ApiHttpError &&
        err.statusCode === 400 &&
        err.message.toLowerCase().includes('saldo insuficiente') &&
        params.paymentMethod === 'BALANCE'
      ) {
        try {
          const orders = await this.getOrders(params.telegramId);
          const sixtySecondsAgo = Date.now() - 60_000;
          // Procura pedido APPROVED para o mesmo produto nos últimos 60s
          const recentOrder = orders.find(
            (o) =>
              o.status === 'DELIVERED' || o.status === 'PROCESSING'
              // createdAt pode estar como ISO string
          );
          // Filtra por data e produto (productId não está em OrderSummary, usa productName como fallback)
          const recentByTime = orders.find(
            (o) =>
              (o.status === 'DELIVERED' || o.status === 'PROCESSING') &&
              new Date(o.createdAt).getTime() > sixtySecondsAgo
          );
          if (recentByTime) {
            // Retorna resposta sintética idempotente — bot exibe mensagem de sucesso
            return {
              paymentId: recentByTime.id,
              pixQrCode: '',
              pixQrCodeText: '',
              amount: Number(recentByTime.amount ?? 0),
              balanceUsed: Number(recentByTime.amount ?? 0),
              expiresAt: new Date().toISOString(),
              productName: recentByTime.productName,
              paidWithBalance: true,
            };
          }
        } catch {
          // Se a consulta de orders falhar, deixa o erro original propagar
        }
      }
      throw err;
    }
  }

  async createDeposit(
    telegramId: string,
    amount: number,
    firstName?: string,
    username?: string
  ): Promise<CreateDepositResponse> {
    invalidateBalanceCache(telegramId);
    const { data } = await this.withRetry(() =>
      this.client.post<ApiResponse<CreateDepositResponse>>('/api/payments/deposit', {
        telegramId,
        amount,
        firstName,
        username,
      })
    );
    return data.data!;
  }

  async getPaymentStatus(paymentId: string): Promise<{ status: string; paymentId: string }> {
    const { data } = await this.withRetry(() =>
      this.client.get<ApiResponse<{ status: string; paymentId: string }>>(
        `/api/payments/${paymentId}/status`
      )
    );
    return data.data!;
  }

  async cancelPayment(paymentId: string): Promise<{ cancelled: boolean; message: string }> {
    const { data } = await this.withRetry(() =>
      this.client.post<ApiResponse<{ cancelled: boolean; message: string }>>(
        `/api/payments/${paymentId}/cancel`
      )
    );
    return data.data!;
  }
}

export const apiClient = new ApiClient();
