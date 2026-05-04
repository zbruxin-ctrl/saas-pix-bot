'use client';

import { useState, useEffect, useCallback } from 'react';

// Formato que a API retorna/espera (snake_case, maintenance_mode como string)
interface ApiSettings {
  support_phone: string;
  welcome_message: string;
  maintenance_mode: string;       // 'true' | 'false'
  maintenance_message: string;
}

// Formato do form (mais ergonômico para o React)
interface FormSettings {
  supportPhone: string;
  welcomeMessage: string;
  maintenanceMode: boolean;
  maintenanceMessage: string;
}

const DEFAULTS: FormSettings = {
  supportPhone: '',
  welcomeMessage: '',
  maintenanceMode: false,
  maintenanceMessage: '⚙️ O bot está em manutenção. Voltamos em breve!',
};

function toForm(api: ApiSettings): FormSettings {
  return {
    supportPhone:       api.support_phone ?? '',
    welcomeMessage:     api.welcome_message ?? '',
    maintenanceMode:    api.maintenance_mode === 'true',
    maintenanceMessage: api.maintenance_message ?? '',
  };
}

function toApi(form: FormSettings): Record<string, string> {
  return {
    support_phone:       form.supportPhone,
    welcome_message:     form.welcomeMessage,
    maintenance_mode:    form.maintenanceMode ? 'true' : 'false',
    maintenance_message: form.maintenanceMessage,
  };
}

function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 ${
        checked ? 'bg-red-500' : 'bg-gray-200'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  );
}

/** Converte **texto** → <b>texto</b> e _texto_ → <i>texto</i> para preview */
function previewMarkdown(text: string): string {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>')
    .replace(/_(.*?)_/g, '<i>$1</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br/>');
}

const WELCOME_VARS = [
  { tag: '{nome}',     desc: 'Primeiro nome' },
  { tag: '{username}', desc: '@username do Telegram' },
];

const WELCOME_FORMATTING = [
  { tag: '**texto**', desc: 'Negrito' },
  { tag: '_texto_',   desc: 'Itálico' },
  { tag: '`código`',  desc: 'Monoespaçado' },
];

export default function SettingsPage() {
  const [settings, setSettings] = useState<FormSettings>(DEFAULTS);
  const [original, setOriginal] = useState<FormSettings>(DEFAULTS);
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const [welcomePreview, setWelcomePreview] = useState(false);

  function showToast(msg: string, type: 'success' | 'error') {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res  = await fetch('/api/admin/settings', { credentials: 'include' });
      const data = await res.json();
      if (data.success && data.data) {
        const form = toForm(data.data as ApiSettings);
        setSettings(form);
        setOriginal(form);
      }
    } catch {
      //
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function set<K extends keyof FormSettings>(key: K, value: FormSettings[K]) {
    setSettings((s) => ({ ...s, [key]: value }));
  }

  const isDirty = JSON.stringify(settings) !== JSON.stringify(original);

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // API espera: { settings: { support_phone: '...', ... } }
        body: JSON.stringify({ settings: toApi(settings) }),
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Erro ao salvar');
      setOriginal(settings);
      showToast('Configurações salvas com sucesso', 'success');
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'Erro ao salvar', 'error');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Configurações</h1>
        </div>
        <div className="card flex items-center justify-center py-16">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Configurações</h1>
        <p className="text-gray-500 text-sm mt-1">
          Gerencie as configurações do bot sem precisar fazer novo deploy
        </p>
      </div>

      {/* Toast */}
      {toast && (
        <div
          className={`rounded-xl border px-4 py-3 text-sm flex items-center gap-3 ${
            toast.type === 'success'
              ? 'border-green-200 bg-green-50 text-green-800'
              : 'border-red-200 bg-red-50 text-red-800'
          }`}
        >
          <span className="text-lg">{toast.type === 'success' ? '✅' : '❌'}</span>
          {toast.msg}
        </div>
      )}

      {/* Card principal */}
      <div className="card space-y-6">

        {/* Modo Manutenção */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-gray-900">Modo Manutenção</p>
              <p className="text-sm text-gray-500 mt-0.5">
                Bloqueia novas compras e exibe aviso de manutenção aos usuários
              </p>
            </div>
            <Toggle
              checked={settings.maintenanceMode}
              onChange={(v) => set('maintenanceMode', v)}
            />
          </div>

          {settings.maintenanceMode && (
            <div className="space-y-1">
              <label className="block text-sm font-medium text-gray-700">
                Mensagem exibida durante a manutenção
              </label>
              <textarea
                className="input w-full min-h-[80px] resize-y text-sm"
                value={settings.maintenanceMessage}
                onChange={(e) => set('maintenanceMessage', e.target.value)}
                placeholder="⚙️ Bot em manutenção. Voltamos em breve!"
              />
            </div>
          )}
        </div>

        <div className="border-t border-gray-100" />

        {/* Suporte */}
        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-gray-900">
            Número de Suporte (WhatsApp)
          </label>
          <p className="text-sm text-gray-500">
            Número exibido no botão "Falar com suporte" do bot
          </p>
          <div className="flex items-center gap-2 mt-2">
            <span className="text-sm text-gray-500 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 select-none whitespace-nowrap">
              wa.me/
            </span>
            <input
              className="input flex-1"
              placeholder="5511999999999"
              value={settings.supportPhone}
              onChange={(e) => set('supportPhone', e.target.value.replace(/\D/g, ''))}
            />
          </div>
          {settings.supportPhone && (
            <p className="text-xs text-blue-600 mt-1">
              Link:{' '}
              <a
                href={`https://wa.me/${settings.supportPhone}`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-blue-800"
              >
                wa.me/{settings.supportPhone}
              </a>
            </p>
          )}
          <p className="text-xs text-gray-400">
            Somente números com DDI. Ex:{' '}
            <code className="bg-gray-100 px-1 rounded">5511999999999</code>
          </p>
        </div>

        <div className="border-t border-gray-100" />

        {/* Boas-vindas */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <label className="block text-sm font-medium text-gray-900">
                Mensagem de Boas-vindas
              </label>
              <p className="text-sm text-gray-500 mt-0.5">
                Exibida quando o usuário usa{' '}
                <code className="bg-gray-100 px-1 rounded text-xs">/start</code>
              </p>
            </div>
            <button
              type="button"
              onClick={() => setWelcomePreview((v) => !v)}
              className={`text-xs px-3 py-1.5 rounded-lg border font-medium transition-colors ${
                welcomePreview
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
              }`}
            >
              {welcomePreview ? '✏️ Editar' : '👁 Preview'}
            </button>
          </div>

          {/* Chips de variáveis e formatação */}
          <div className="flex flex-wrap gap-1.5">
            {WELCOME_VARS.map((v) => (
              <button
                key={v.tag}
                type="button"
                title={v.desc}
                onClick={() => set('welcomeMessage', settings.welcomeMessage + v.tag)}
                className="text-xs bg-blue-50 text-blue-700 border border-blue-200 px-2 py-1 rounded-md hover:bg-blue-100 transition-colors font-mono"
              >
                {v.tag}
              </button>
            ))}
            {WELCOME_FORMATTING.map((f) => (
              <button
                key={f.tag}
                type="button"
                title={f.desc}
                onClick={() => set('welcomeMessage', settings.welcomeMessage + f.tag)}
                className="text-xs bg-gray-50 text-gray-600 border border-gray-200 px-2 py-1 rounded-md hover:bg-gray-100 transition-colors font-mono"
              >
                {f.tag}
              </button>
            ))}
          </div>

          {welcomePreview ? (
            <div
              className="input w-full min-h-[140px] bg-gray-50 text-sm whitespace-pre-wrap leading-relaxed select-none"
              dangerouslySetInnerHTML={{
                __html: settings.welcomeMessage
                  ? previewMarkdown(
                      settings.welcomeMessage
                        .replace(/\{nome\}/gi, '<span class="font-semibold text-blue-600">João</span>')
                        .replace(/\{username\}/gi, '<span class="font-semibold text-blue-600">@joao</span>')
                    )
                  : '<span class="text-gray-400">Nenhuma mensagem configurada…</span>',
              }}
            />
          ) : (
            <textarea
              className="input w-full min-h-[140px] resize-y text-sm font-mono mt-1"
              placeholder={`👋 Olá, {nome}! Bem-vindo!\n\n🛒 Aqui você pode adquirir nossos produtos de forma **rápida** e **segura**.\n\n💳 Aceitamos **PIX** e _saldo pré-carregado_.`}
              value={settings.welcomeMessage}
              onChange={(e) => set('welcomeMessage', e.target.value)}
              spellCheck={false}
            />
          )}

          <div className="grid grid-cols-2 gap-2 text-xs text-gray-500">
            <div className="bg-gray-50 rounded-lg px-3 py-2 space-y-1">
              <p className="font-medium text-gray-700">📌 Variáveis</p>
              {WELCOME_VARS.map((v) => (
                <p key={v.tag}><code className="bg-gray-100 px-1 rounded">{v.tag}</code> — {v.desc}</p>
              ))}
            </div>
            <div className="bg-gray-50 rounded-lg px-3 py-2 space-y-1">
              <p className="font-medium text-gray-700">✏️ Formatação</p>
              {WELCOME_FORMATTING.map((f) => (
                <p key={f.tag}><code className="bg-gray-100 px-1 rounded">{f.tag}</code> — {f.desc}</p>
              ))}
            </div>
          </div>
        </div>

        {/* Ações */}
        <div className="flex items-center justify-end gap-3 pt-3 border-t border-gray-100">
          {isDirty && (
            <button
              onClick={() => setSettings(original)}
              disabled={saving}
              className="btn-secondary text-sm"
            >
              Descartar alterações
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={!isDirty || saving}
            className="btn-primary disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? (
              <span className="flex items-center gap-2">
                <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-white inline-block" />
                Salvando...
              </span>
            ) : (
              '💾 Salvar configurações'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
