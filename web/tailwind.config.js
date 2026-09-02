/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Dynamic accent — references CSS variable so JS brand-color updates work
        accent: {
          DEFAULT: 'var(--accent)',
          hover:   'var(--accent-hover)',
          text:    'var(--accent-text)',
          dim:     'var(--accent-dim)',
        },
        surface: {
          page:   '#f3f4f6',
          panel:  '#ffffff',
          raised: '#ffffff',
          sunken: '#f9fafb',
        },
        state: {
          bot:        '#15803d',
          'bot-bg':   '#f0fdf4',
          pending:    '#78716c',
          'pending-bg':'#fafaf9',
          human:      '#475569',
          'human-bg': '#f8fafc',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
      fontSize: {
        '2xs': ['12px', { lineHeight: '1.4' }],
        xs:    ['13px', { lineHeight: '1.4' }],
        sm:    ['15px', { lineHeight: '1.5' }],
        base:  ['16px', { lineHeight: '1.5' }],
        md:    ['17px', { lineHeight: '1.5' }],
        lg:    ['19px', { lineHeight: '1.5' }],
        xl:    ['22px', { lineHeight: '1.3' }],
        '2xl': ['27px', { lineHeight: '1.2' }],
        '3xl': ['36px', { lineHeight: '1.2' }],
        '4xl': ['40px', { lineHeight: '1.1' }],
        '5xl': ['52px', { lineHeight: '1' }],
      },
      width: {
        sidebar: '224px',
        'chat-list': '320px',
        'context': '272px',
      },
      minWidth: {
        sidebar: '224px',
      },
      maxWidth: {
        admin: '860px',
      },
      height: {
        header: '56px',
      },
      borderRadius: {
        sm: '4px',
        md: '8px',
        lg: '12px',
        xl: '16px',
        full: '9999px',
      },
      boxShadow: {
        xs: '0 1px 2px 0 rgba(0,0,0,0.04)',
        sm: '0 1px 3px 0 rgba(0,0,0,0.08), 0 1px 2px -1px rgba(0,0,0,0.06)',
        md: '0 4px 8px -2px rgba(0,0,0,0.08), 0 2px 4px -2px rgba(0,0,0,0.06)',
        lg: '0 12px 24px -4px rgba(0,0,0,0.10), 0 4px 8px -2px rgba(0,0,0,0.06)',
        xl: '0 20px 40px -8px rgba(0,0,0,0.12), 0 8px 16px -4px rgba(0,0,0,0.08)',
      },
      animation: {
        shimmer: 'shimmer 1.5s infinite',
        'slide-in-right': 'slideInRight 0.25s cubic-bezier(0.16,1,0.3,1)',
        'slide-up': 'slideUp 0.2s cubic-bezier(0.16,1,0.3,1)',
        spin: 'spin 0.7s linear infinite',
      },
      keyframes: {
        shimmer: {
          '0%':   { backgroundPosition: '-600px 0' },
          '100%': { backgroundPosition: '600px 0' },
        },
        slideInRight: {
          from: { transform: 'translateX(100%)' },
          to:   { transform: 'translateX(0)' },
        },
        slideUp: {
          from: { transform: 'translateY(8px)', opacity: 0 },
          to:   { transform: 'translateY(0)', opacity: 1 },
        },
      },
    },
  },
  plugins: [],
};
