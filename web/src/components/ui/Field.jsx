import React from 'react';

export default function Field({ label, helper, error, children, required }) {
  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label className="text-[11px] font-semibold text-gray-600 uppercase tracking-wide" style={{ letterSpacing: '0.06em' }}>
          {label}
          {required && <span className="text-red-500 ml-0.5">*</span>}
        </label>
      )}
      {children}
      {helper && !error && (
        <p className="text-[11px] text-gray-400 leading-relaxed">{helper}</p>
      )}
      {error && (
        <p className="text-[11px] text-red-500 leading-relaxed">{error}</p>
      )}
    </div>
  );
}

export function InputField({ label, helper, error, textarea, required, ...props }) {
  return (
    <Field label={label} helper={helper} error={error} required={required}>
      {textarea
        ? (
          <textarea
            className="field-textarea"
            required={required}
            {...props}
          />
        )
        : (
          <input
            className="field-input"
            required={required}
            {...props}
          />
        )
      }
    </Field>
  );
}
