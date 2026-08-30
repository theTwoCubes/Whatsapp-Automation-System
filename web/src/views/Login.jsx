import React, { useContext, useState } from 'react';
import { ArrowRight, Eye, EyeOff } from 'lucide-react';
import { BrandContext } from '../brand.js';
import { api, setToken } from '../api.js';

export default function Login({ onLogin }) {
  const brand     = useContext(BrandContext);
  const brandName = brand?.name || 'Console';

  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [error,    setError]    = useState('');
  const [busy,     setBusy]     = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { token } = await api.login(email, password);
      setToken(token);
      onLogin();
    } catch (err) {
      setError(
        err.message === 'unauthorized'
          ? 'Incorrect email or password.'
          : err.message,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-[100dvh] overflow-hidden bg-white">

      {/* Left panel: illustration */}
      <div 
        className="hidden md:flex relative overflow-hidden items-center justify-center bg-white"
      >
        <img
          src="/login-panel.png"
          alt="WhatsApp automation illustration"
          draggable={false}
          className="h-full w-auto object-contain max-w-[65vw]"
        />
      </div>

      {/* Right panel: form */}
      <div
        className="flex-1 flex items-center justify-center overflow-y-auto bg-white border-l border-gray-100"
      >
        <div className="w-full max-w-[540px] flex flex-col gap-10 px-12 py-16">

          {/* Brand Logo */}
          <div className="flex items-center gap-3">
            <img
              src="/logo.png"
              alt={brandName}
              className="w-14 h-14 rounded-xl object-cover flex-shrink-0 shadow-sm"
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
            <div>
              <div className="font-bold text-xl text-gray-900 leading-tight tracking-tight">
                {brandName}
              </div>
              <div className="text-xs text-gray-400 flex items-center gap-1.5 mt-0.5">
                <span
                  className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
                  style={{ background: '#25d366' }}
                />
                WhatsApp Business Platform
              </div>
            </div>
          </div>

          {/* Heading */}
          <div>
            <h1 className="text-4xl font-bold text-gray-900 tracking-tight mb-3">
              Welcome back
            </h1>
            <p className="text-lg text-gray-400">Sign in to your workspace</p>
          </div>

          {/* Login Form */}
          <form onSubmit={submit} noValidate autoComplete="on" className="flex flex-col gap-6">

            {/* Email */}
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="login-email"
                className="text-sm font-semibold text-gray-600 uppercase tracking-wide"
                style={{ letterSpacing: '0.06em' }}
              >
                Email address
              </label>
              <input
                id="login-email"
                type="email"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoFocus
                autoComplete="email"
                required
                className="w-full h-14 px-5 text-lg text-gray-900 bg-white border border-gray-200 rounded-xl outline-none transition-colors duration-100 placeholder:text-gray-400"
                style={{
                  boxShadow: 'none',
                }}
                onFocus={(e) => {
                  e.target.style.borderColor = 'var(--accent)';
                  e.target.style.boxShadow   = '0 0 0 3px var(--accent-dim)';
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = '';
                  e.target.style.boxShadow   = '';
                }}
              />
            </div>

            {/* Password */}
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="login-password"
                className="text-sm font-semibold text-gray-600 uppercase tracking-wide"
                style={{ letterSpacing: '0.06em' }}
              >
                Password
              </label>
              <div className="relative">
                <input
                  id="login-password"
                  type={showPass ? 'text' : 'password'}
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                  className="w-full h-14 px-5 pr-14 text-lg text-gray-900 bg-white border border-gray-200 rounded-xl outline-none transition-colors duration-100 placeholder:text-gray-400"
                  onFocus={(e) => {
                    e.target.style.borderColor = 'var(--accent)';
                    e.target.style.boxShadow   = '0 0 0 3px var(--accent-dim)';
                  }}
                  onBlur={(e) => {
                    e.target.style.borderColor = '';
                    e.target.style.boxShadow   = '';
                  }}
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowPass((v) => !v)}
                  aria-label={showPass ? 'Hide password' : 'Show password'}
                  className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center justify-center p-1 text-gray-400 hover:text-gray-600 transition-colors rounded"
                >
                  {showPass ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>

            {/* Error */}
            {error && (
              <div
                role="alert"
                className="px-4 py-3 text-sm rounded-lg border"
                style={{ background: '#fef2f2', borderColor: '#fecaca', color: '#dc2626' }}
              >
                {error}
              </div>
            )}

            {/* Submit */}
            <button
              id="login-submit"
              type="submit"
              disabled={busy || !email || !password}
              className="w-full h-14 mt-2 flex items-center justify-center gap-2 text-base font-semibold text-white rounded-xl transition-all duration-100 disabled:opacity-50 disabled:cursor-not-allowed hover:enabled:-translate-y-px active:enabled:translate-y-0"
              style={{ background: 'var(--accent)' }}
              onMouseEnter={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.background = 'var(--accent-hover)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--accent)'; }}
            >
              {busy ? (
                <span className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
              ) : (
                <>
                  Sign in
                  <ArrowRight size={16} />
                </>
              )}
            </button>
          </form>

          {/* Support link */}
          {brand?.supportEmail && (
            <p className="text-center text-sm text-gray-400 mt-4">
              Need help?{' '}
              <a
                href={`mailto:${brand.supportEmail}`}
                className="underline underline-offset-2 hover:text-gray-600 transition-colors"
                style={{ color: 'var(--accent-text)' }}
              >
                {brand.supportEmail}
              </a>
            </p>
          )}

        </div>
      </div>

    </div>
  );
}
