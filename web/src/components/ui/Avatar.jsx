import React from 'react';
import { avatarColor, initials } from '../../lib.js';

const sizeMap = {
  lg: 'w-10 h-10 text-[15px]',
  md: 'w-[34px] h-[34px] text-[13px]',
  sm: 'w-7 h-7 text-[11px]',
};

export default function Avatar({ name, waId, size = 'md' }) {
  const bg   = avatarColor(waId || name || '');
  const text = initials(name, waId);
  return (
    <div
      className={`rounded-full flex items-center justify-center font-semibold text-white flex-shrink-0 tracking-tight select-none ${sizeMap[size] || sizeMap.md}`}
      style={{ background: bg }}
      aria-label={name || waId}
    >
      {text}
    </div>
  );
}
