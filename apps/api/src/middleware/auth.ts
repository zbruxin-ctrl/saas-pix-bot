// middleware/auth.ts — autenticação JWT com respostas consistentes
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';

export interface AuthenticatedRequest extends Request {
  admin?: {
    id: string;
    email: string;
    role: string;
  };
}

export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token =
      req.signedCookies?.auth_token ||
      req.cookies?.auth_token ||
      extractBearerToken(req);

    if (!token) {
      res.status(401).json({ success: false, error: 'Não autorizado' });
      return;
    }

    const payload = jwt.verify(token, env.JWT_SECRET) as {
      adminId: string;
      email: string;
      role: string;
    };

    const admin = await prisma.adminUser.findUnique({
      where: { id: payload.adminId },
      select: { id: true, email: true, role: true, isActive: true },
    });

    if (!admin || !admin.isActive) {
      res.status(401).json({ success: false, error: 'Sessão inválida' });
      return;
    }

    req.admin = { id: admin.id, email: admin.email, role: admin.role };
    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      res.status(401).json({ success: false, error: 'Sessão expirada' });
      return;
    }
    // Token inválido é erro de autenticação, não erro interno
    res.status(401).json({ success: false, error: 'Token inválido' });
  }
}

export function requireRole(...roles: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.admin || !roles.includes(req.admin.role)) {
      res.status(403).json({ success: false, error: 'Acesso negado' });
      return;
    }
    next();
  };
}

function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);
  return null;
}

export function requireBotSecret(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const secret = req.headers['x-bot-secret'];
  if (!secret || secret !== env.TELEGRAM_BOT_SECRET) {
    res.status(401).json({ success: false, error: 'Não autorizado' });
    return;
  }
  next();
}
