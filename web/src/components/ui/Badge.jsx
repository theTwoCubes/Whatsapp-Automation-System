import React from 'react';

// variant → [bg, text, border] Tailwind classes
const variantMap = {
  bot:     'bg-green-50  text-green-700  border border-green-200',
  pending: 'bg-amber-50  text-amber-700  border border-amber-200',
  human:   'bg-blue-50   text-blue-700   border border-blue-200',
  neutral: 'bg-gray-100  text-gray-600   border border-gray-200',
  success: 'bg-green-50  text-green-700  border border-green-200',
  error:   'bg-red-50    text-red-600    border border-red-200',
  warning: 'bg-amber-50  text-amber-700  border border-amber-200',
};

export default function Badge({ variant = 'neutral', children, className = '', ...props }) {
  const cls = variantMap[variant] || variantMap.neutral;
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold leading-4 ${cls} ${className}`}
      {...props}
    >
      {children}
    </span>
  );
}

export function StateBadge({ state }) {
  const map = {
    bot:     { variant: 'bot',     label: 'AI' },
    pending: { variant: 'pending', label: 'Waiting' },
    human:   { variant: 'human',   label: 'Agent' },
  };
  const { variant, label } = map[state] || { variant: 'neutral', label: state };
  return <Badge variant={variant}>{label}</Badge>;
}
