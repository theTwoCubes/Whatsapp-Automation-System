import React from 'react';

export function Skeleton({ width, height = 16, className = '', style }) {
  return (
    <div
      className={`skeleton-shimmer rounded ${className}`}
      style={{ width, height, ...style }}
      aria-hidden="true"
    />
  );
}

export function ChatRowSkeleton() {
  return (
    <div className="flex gap-3 px-4 py-3 border-b border-gray-200 items-center">
      <Skeleton width={40} height={40} className="rounded-full flex-shrink-0" />
      <div className="flex-1">
        <Skeleton width="55%" height={13} style={{ marginBottom: 6 }} />
        <Skeleton width="80%" height={11} />
      </div>
    </div>
  );
}
