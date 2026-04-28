// Cliente HTTP para comunicação do bot com a API interna
// PERF #1: timeout reduzido para 8s (era 15s) — feedback mais rápido ao usuário
// PERF #4: retry automático 1x em timeout/network error
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

// PERF #2: cache global de produtos compartilhado entre todas as sessões (TTL 60s)
interface ProductCache {
  products: ProductDTO[];
  expiresAt: number;
}
let productCache: ProductCache | null = null;
const PRODUCT_CACHE_TTL = 60_000; // 60 segundos

export function invalidateProductCache(): void {
  productCache = null;
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
      timeout: 8000, // PERF #1: era 15000
    });

    this.client.interceptors.response.use(
      (r) => r,
      (error) => {
        const msg = error.response?.data?.error || error.message;
        throw new Error(msg);
      }
    );
  }

  // PERF #4: helper de retry automático 1x em caso de timeout ou network error
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      const isRetryable =
        msg.toLowerCase().includes('timeout') ||
        msg.toLowerCase().includes('econnreset') ||
        msg.toLowerCase().includes('network error') ||
        (err instanceof AxiosError && !err.response); // sem resposta = network issue
      if (isRetryable) {
        // Aguarda 500ms antes do retry para dar tempo ao servidor
        await new Promise((r) => setTimeout(r, 500));
        return await fn();
      }
      throw err;
    }
  }

  // PERF #2: usa cache global com TTL 60s; só bate na API se cache expirado
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

  async createPayment(params: {
    telegramId: string;
    productId: string;
    firstName?: string;
    username?: string;
    paymentMethod?: PaymentMethod;
  }): Promise<CreatePaymentResponse> {
    const { data } = await this.withRetry(() =>
      this.client.post<ApiResponse<CreatePaymentResponse>>('/api/payments/create', params)
    );
    return data.data!;
  }

  async createDeposit(
    telegramId: string,
    amount: number,
    firstName?: string,
    username?: string
  ): Promise<CreateDepositResponse> {
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

  async getBalance(telegramId: string): Promise<WalletBalanceResponse> {
    const { data } = await this.withRetry(() =>
      this.client.get<ApiResponse<WalletBalanceResponse>>(
        `/api/payments/balance?telegramId=${encodeURIComponent(telegramId)}`
      )
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
