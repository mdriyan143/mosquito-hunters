import './globals.css';

export const metadata = {
  authors: [{ name: 'Md Riyan Biswas' }],
  creator: 'Md Riyan Biswas',
  title: 'Hit Machar – Endless Stick Shooter',
  description: 'Hold to aim, release to fire. Swat every mosquito before it ruins your sleep.',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#ffffff',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Dancing+Script:wght@400;700&family=Kaushan+Script&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}