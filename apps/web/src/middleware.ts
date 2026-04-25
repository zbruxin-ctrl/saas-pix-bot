import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isAdminRoute = pathname.startsWith('/admin');
  const isLoginPage = pathname === '/login';

  // Verifica presença do cookie — setado pela rota /api/auth/login do Next.js
  const hasSession = request.cookies.has('auth_presence') &&
    request.cookies.get('auth_presence')?.value === '1';

  // Sem sessão tentando acessar admin → vai para login
  if (isAdminRoute && !hasSession) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('from', pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Com sessão tentando acessar login → vai para admin
  if (isLoginPage && hasSession) {
    return NextResponse.redirect(new URL('/admin', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*', '/login'],
};
