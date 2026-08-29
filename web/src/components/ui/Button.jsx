import React from 'react';

const base = 'inline-flex items-center justify-center gap-2 rounded-md font-semibold text-sm border transition-all duration-100 font-sans whitespace-nowrap cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed';

const variants = {
  primary:      'bg-[var(--accent)] text-white border-[var(--accent)] hover:bg-[var(--accent-hover)] hover:border-[var(--accent-hover)]',
  secondary:    'bg-white text-gray-700 border-gray-200 hover:bg-gray-50 hover:border-gray-300',
  ghost:        'bg-transparent text-gray-600 border-transparent hover:bg-gray-100',
  danger:       'bg-red-600 text-white border-red-600 hover:bg-red-700 hover:border-red-700',
  'danger-ghost':'bg-transparent text-red-600 border-transparent hover:bg-red-50',
};

const sizes = {
  sm: 'h-8 px-3 text-sm',
  md: 'h-10 px-4 text-base',
  lg: 'h-12 px-6 text-base',
};

export default function Button({
  variant = 'primary',
  size = 'md',
  children,
  className = '',
  ...props
}) {
  return (
    <button
      className={`${base} ${variants[variant] || variants.primary} ${sizes[size] || sizes.md} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
