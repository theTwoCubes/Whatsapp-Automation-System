import React from 'react';

export default function Field({ label, helper, error, children, required }) {
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label className="text-base font-medium text-gray-800">
          {label}
          {required && <span className="text-red-500 ml-0.5">*</span>}
        </label>
      )}
      {children}
      {helper && !error && (
        <p className="text-sm text-gray-500 leading-relaxed">{helper}</p>
      )}
      {error && (
        <p className="text-sm text-red-500 leading-relaxed">{error}</p>
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
