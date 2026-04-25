// apps/web/src/lib/api.ts
import axios from 'axios';

// Para rotas autenticadas, usa o proxy Next.js que encaminha o cookie.
// Para login (sem cookie ainda), chama direto /api/auth/login (route.ts).
const api = axios.create({
  baseURL: '/api/proxy',
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      // Remove cookie de presença e redireciona para login
      document.cookie = 'auth_presence=; Max-Age=0; path=/';
      if (typeof window !== 'undefined' && !window.location.pathname.includes('/login')) {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

export default api;
