import React from 'react';

const variantMap = {
  bot:      'text-green-700',
  pending:  'text-stone-600',
  human:    'text-slate-600',
  rejected: 'text-red-500',
  neutral:  'text-gray-600',
  success:  'text-green-700',
  error:    'text-red-600',
  warning:  'text-stone-600',
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
    bot:      { variant: 'bot',      label: 'AI' },
    pending:  { variant: 'pending',  label: 'Waiting' },
    human:    { variant: 'human',    label: 'Agent' },
    rejected: { variant: 'rejected', label: 'Rejected' },
  };
  const { variant, label } = map[state] || { variant: 'neutral', label: state };
  return <Badge variant={variant}>{label}</Badge>;
}
