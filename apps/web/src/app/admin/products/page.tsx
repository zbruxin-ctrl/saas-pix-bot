'use client';

import { useEffect, useState, useMemo } from 'react';
import { getProducts, createProduct, updateProduct, deleteProduct } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { toast } from '@/components/admin/Toast';
import ConfirmModal from '@/components/admin/ConfirmModal';

interface Product {
  id: string;
  name: string;
  description: string;
  price: number;
  deliveryType: string;
  deliveryContent: string;
  isActive: boolean;
  stock: number | null;
  _count?: { payments: number; orders: number };
}

const EMPTY_FORM = {
  name: '',
  description: '',
  price: '',
  deliveryType: 'TEXT',
  deliveryContent: '',
  isActive: true,
  stock: '',
};

function validate(form: typeof EMPTY_FORM): string | null {
  if (!form.name.trim()) return 'O nome do produto é obrigatório.';
  if (!form.description.trim()) return 'A descrição é obrigatória.';
  const price = parseFloat(form.price);
  if (isNaN(price) || price <= 0) return 'Informe um preço válido maior que zero.';
  if (!form.deliveryContent.trim()) return 'O conteúdo de entrega é obrigatório.';
  if (form.deliveryType === 'ACCOUNT') {
    try {
      JSON.parse(form.deliveryContent);
    } catch {
      return 'O conteúdo de entrega deve ser um JSON válido para o tipo ACCOUNT.';
    }
  }
  return null;
}

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const loadProducts = () => {
    setLoading(true);
    getProducts()
      .then(setProducts)
      .catch(() => toast('Erro ao carregar produtos', 'error'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadProducts();
  }, []);

  const filtered = useMemo(() => {
    return products.filter((p) => {
      const matchSearch =
        p.name.toLowerCase().includes(search.toLowerCase()) ||
        p.description.toLowerCase().includes(search.toLowerCase());

      const matchFilter =
        filter === 'all' ? true : filter === 'active' ? p.isActive : !p.isActive;

      return matchSearch && matchFilter;
    });
  }, [products, search, filter]);

  function openCreate() {
    setForm(EMPTY_FORM);
    setEditId(null);
    setFieldError('');
    setShowModal(true);
  }

  function openEdit(p: Product) {
    setForm({
      name: p.name,
      description: p.description,
      price: String(p.price),
      deliveryType: p.deliveryType,
      deliveryContent: p.deliveryContent || '',
      isActive: p.isActive,
      stock: p.stock != null ? String(p.stock) : '',
    });
    setEditId(p.id);
    setFieldError('');
    setShowModal(true);
  }

  async function handleSave() {
    const err = validate(form);
    if (err) {
      setFieldError(err);
      return;
    }

    setSaving(true);
    setFieldError('');

    try {
      const payload = {
        ...form,
        price: parseFloat(form.price),
        stock: form.stock ? parseInt(form.stock) : null,
      };

      if (editId) {
        await updateProduct(editId, payload);
        toast('Produto atualizado com sucesso!', 'success');
      } else {
        await createProduct(payload);
        toast('Produto criado com sucesso!', 'success');
      }

      setShowModal(false);
      loadProducts();
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setFieldError(msg || 'Erro ao salvar produto. Tente novamente.');
    } finally {
      setSaving(false);
    }
  }

  async function handleConfirmDelete() {
    if (!confirmDelete) return;

    try {
      await deleteProduct(confirmDelete);
      toast('Produto desativado.', 'info');
      loadProducts();
    } catch {
      toast('Erro ao desativar produto.', 'error');
    } finally {
      setConfirmDelete(null);
    }
  }

  const deliveryPlaceholder =
    form.deliveryType === 'ACCOUNT'
      ? '{"message": "Acesso liberado!", "accessUrl": "https://..."}'
      : 'Texto, link ou token enviado ao usuário após o pagamento';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Produtos</h1>
          <p className="text-gray-500 text-sm mt-1">
            {filtered.length} de {products.length} produto{products.length !== 1 ? 's' : ''}
          </p>
        </div>
        <button onClick={openCreate} className="btn-primary">
          + Novo Produto
        </button>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <input
          className="input flex-1"
          placeholder="Buscar por nome ou descrição..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="flex gap-2">
          {(['all', 'active', 'inactive'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={[
                'px-3 py-2 rounded-lg text-sm font-medium transition-colors border',
                filter === f
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300',
              ].join(' ')}
            >
              {f === 'all' ? 'Todos' : f === 'active' ? 'Ativos' : 'Inativos'}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="card space-y-3 animate-pulse">
              <div className="h-5 bg-gray-200 rounded w-2/3" />
              <div className="h-3 bg-gray-100 rounded w-full" />
              <div className="h-3 bg-gray-100 rounded w-4/5" />
              <div className="h-8 bg-gray-200 rounded w-1/3 mt-2" />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <div className="text-4xl mb-3">📦</div>
          <p className="font-medium text-gray-500">Nenhum produto encontrado</p>
          <p className="text-sm mt-1">
            {search
              ? 'Tente outros termos de busca'
              : 'Crie seu primeiro produto clicando em "+ Novo Produto"'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map((p) => (
            <div key={p.id} className={['card relative', !p.isActive ? 'opacity-60' : ''].join(' ')}>
              <div className="flex items-start justify-between mb-1">
                <h3 className="font-semibold text-gray-900 pr-4 leading-snug">{p.name}</h3>
                <span
                  className={[
                    'shrink-0 text-xs px-2 py-0.5 rounded-full font-medium',
                    p.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-500',
                  ].join(' ')}
                >
                  {p.isActive ? 'Ativo' : 'Inativo'}
                </span>
              </div>
              <p className="text-sm text-gray-500 mb-3 line-clamp-2">{p.description}</p>
              <div className="text-2xl font-bold text-blue-600 mb-3">{formatCurrency(p.price)}</div>
              <div className="flex items-center gap-2 text-xs text-gray-500 mb-4">
                <span className="bg-gray-100 px-2 py-1 rounded">{p.deliveryType}</span>
                {p.stock != null && (
                  <span className="bg-yellow-100 text-yellow-700 px-2 py-1 rounded">
                    {p.stock} em estoque
                  </span>
                )}
              </div>
              {p._count && (
                <div className="text-xs text-gray-400 mb-4">
                  {p._count.payments} pagamentos · {p._count.orders} pedidos
                </div>
              )}
              <div className="flex gap-2">
                <button onClick={() => openEdit(p)} className="btn-secondary text-sm flex-1">
                  Editar
                </button>
                <button
                  onClick={() => setConfirmDelete(p.id)}
                  className="btn-danger text-sm px-3"
                  title="Desativar produto"
                >
                  🗑
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6">
            <h2 className="text-xl font-bold text-gray-900 mb-6">
              {editId ? 'Editar Produto' : 'Novo Produto'}
            </h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Nome *</label>
                <input
                  className="input"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Ex: Plano Pro"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Descrição *</label>
                <textarea
                  className="input"
                  rows={2}
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="Descrição exibida no bot"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Preço (R$) *</label>
                  <input
                    className="input"
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={form.price}
                    onChange={(e) => setForm({ ...form, price: e.target.value })}
                    placeholder="29.90"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Estoque</label>
                  <input
                    className="input"
                    type="number"
                    min="0"
                    value={form.stock}
                    onChange={(e) => setForm({ ...form, stock: e.target.value })}
                    placeholder="Vazio = ilimitado"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Tipo de Entrega *</label>
                <select
                  className="input"
                  value={form.deliveryType}
                  onChange={(e) => setForm({ ...form, deliveryType: e.target.value })}
                >
                  <option value="TEXT">TEXT — Mensagem de texto</option>
                  <option value="LINK">LINK — Link de acesso</option>
                  <option value="TOKEN">TOKEN — Chave/Token</option>
                  <option value="ACCOUNT">ACCOUNT — Dados de conta (JSON)</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Conteúdo de Entrega *</label>
                <textarea
                  className="input font-mono text-xs"
                  rows={4}
                  value={form.deliveryContent}
                  onChange={(e) => setForm({ ...form, deliveryContent: e.target.value })}
                  placeholder={deliveryPlaceholder}
                />
                {form.deliveryType === 'ACCOUNT' && (
                  <p className="text-xs text-gray-400 mt-1">Insira um JSON válido.</p>
                )}
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="isActive"
                  checked={form.isActive}
                  onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                  className="rounded"
                />
                <label htmlFor="isActive" className="text-sm font-medium text-gray-700">
                  Produto ativo
                </label>
              </div>
            </div>

            {fieldError && (
              <div className="mt-4 bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm flex items-start gap-2">
                <span>⚠️</span>
                <span>{fieldError}</span>
              </div>
            )}

            <div className="flex gap-3 mt-6">
              <button onClick={() => setShowModal(false)} className="btn-secondary flex-1">
                Cancelar
              </button>
              <button onClick={handleSave} disabled={saving} className="btn-primary flex-1">
                {saving ? 'Salvando...' : editId ? 'Salvar Alterações' : 'Criar Produto'}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmModal
        open={!!confirmDelete}
        title="Desativar produto?"
        message="O produto não aparecerá mais no bot. Você pode reativá-lo a qualquer momento editando-o."
        confirmLabel="Desativar"
        cancelLabel="Cancelar"
        danger
        onConfirm={handleConfirmDelete}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}