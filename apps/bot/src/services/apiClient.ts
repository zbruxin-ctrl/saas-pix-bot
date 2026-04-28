// Cliente HTTP para comunicação do bot com a API interna
// OPT #A: timeout reduzido para 8s + retry automático 1x em timeout/network error
// OPT #B: cache global de produtos com TTL 60s (compartilhado entre todos os usuários)
import axios, { AxiosInstance } from 'axios';
import { env } from '../config/env';
import type {
  CreatePaymentResponse,
  CreateDepositResponse,
  WalletBalanceResponse,
  ProductDTO,
  ApiResponse,
  PaymentMethod,
} from '@saas-pix/shared';

// ─── OPT #B: cache global de produtos ────────────────────────────────────────
const PRODUCTS_CACHE_TTL = 60_000; // 60s
let productsCache: { data: ProductDTO[]; expiresAt: number } | null = null;

class ApiClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: env.API_URL,
      headers: {
        'Content-Type': 'application/json',
        'x-bot-secret': env.TELEGRAM_BOT_SECRET,
      },
      timeout: 8000, // OPT #A: era 15000
    });

    // OPT #A: retry automático 1x em timeout ou erro de rede
    this.client.interceptors.response.use(
      (r) => r,
      async (error) => {
        const isRetryable =
          error.code === 'ECONNABORTED' ||
          error.code === 'ECONNRESET' ||
          error.code === 'ETIMEDOUT' ||
          !error.response;

        if (isRetryable && !error.config?._retried) {
          error.config._retried = true;
          await new Promise((r) => setTimeout(r, 500));
          return this.client.request(error.config);
        }

        const msg = error.response?.data?.error || error.message;
        throw new Error(msg);
      }
    );
  }

  // OPT #B: retorna cache se válido, senão busca na API
  async getProducts(): Promise<ProductDTO[]> {
    const now = Date.now();
    if (productsCache && productsCache.expiresAt > now) {
      return productsCache.data;
    }
    const { data } = await this.client.get<ApiResponse<ProductDTO[]>>('/api/payments/products');
    productsCache = { data: data.data!, expiresAt: now + PRODUCTS_CACHE_TTL };
    return productsCache.data;
  }

  // OPT #B: força atualização do cache (chamado quando admin altera produtos)
  invalidateProductsCache(): void {
    productsCache = null;
  }

  async createPayment(params: {
    telegramId: string;
    productId: string;
    firstName?: string;
    username?: string;
    paymentMethod?: PaymentMethod;
  }): Promise<CreatePaymentResponse> {
    const { data } = await this.client.post<ApiResponse<CreatePaymentResponse>>(
      '/api/payments/create',
      params
    );
    return data.data!;
  }

  async createDeposit(
    telegramId: string,
    amount: number,
    firstName?: string,
    username?: string
  ): Promise<CreateDepositResponse> {
    const { data } = await this.client.post<ApiResponse<CreateDepositResponse>>(
      '/api/payments/deposit',
      { telegramId, amount, firstName, username }
    );
    return data.data!;
  }

  async getBalance(telegramId: string): Promise<WalletBalanceResponse> {
    const { data } = await this.client.get<ApiResponse<WalletBalanceResponse>>(
      `/api/payments/balance?telegramId=${encodeURIComponent(telegramId)}`
    );
    return data.data!;
  }

  async getPaymentStatus(paymentId: string): Promise<{ status: string; paymentId: string }> {
    const { data } = await this.client.get<ApiResponse<{ status: string; paymentId: string }>>(
      `/api/payments/${paymentId}/status`
    );
    return data.data!;
  }

  async cancelPayment(paymentId: string): Promise<{ cancelled: boolean; message: string }> {
    const { data } = await this.client.post<ApiResponse<{ cancelled: boolean; message: string }>>(
      `/api/payments/${paymentId}/cancel`
    );
    return data.data!;
  }
}

export const apiClient = new ApiClient();
