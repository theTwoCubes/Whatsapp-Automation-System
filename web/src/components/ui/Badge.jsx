import React from 'react';

// variant → [bg, text, border] Tailwind classes
const variantMap = {
  bot:     'text-gray-800',
  pending: 'text-amber-600',
  human:   'text-gray-800',
  neutral: 'text-gray-600',
  success: 'text-gray-800',
  error:   'text-red-600',
  warning: 'text-amber-600',
};

export default function Badge({ variant = 'neutral', children, className = '', ...props }) {
  const cls = variantMap[variant] || variantMap.neutral;
  return (
    <span
      className={`inline-flex items-center text-sm font-semibold leading-4 ${cls} ${className}`}
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
