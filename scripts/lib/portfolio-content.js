// Shared content and PDF builder for the dummy portfolio documents. Used by
// generate-portfolio-pdfs.js (writes files to disk for a quick look) and
// seed-portfolio-media.js (uploads straight to Meta and attaches to FAQs).
// No PDF library needed - the format below is plain enough to hand-build.

function pdfEscape(text) {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

// Wraps a line to fit inside the given character width, greedily.
function wrap(line, width = 90) {
  if (line.length <= width) return [line];
  const words = line.split(' ');
  const out = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > width) {
      out.push(cur.trim());
      cur = w;
    } else {
      cur = (cur + ' ' + w).trim();
    }
  }
  if (cur) out.push(cur);
  return out;
}

// Builds a single/multi page PDF from a flat list of blocks. Each block is
// either { heading: '...' } or { sub: '...' } or { text: '...' } or { spacer: true }.
export function buildPdf(blocks) {
  const linesPerPage = 46;
  const pages = [];
  let page = [];
  const pushLine = (fontSize, text, extraGapAfter = 0) => {
    if (page.length >= linesPerPage) {
      pages.push(page);
      page = [];
    }
    page.push({ fontSize, text });
    for (let i = 0; i < extraGapAfter; i++) {
      if (page.length >= linesPerPage) { pages.push(page); page = []; }
      page.push({ fontSize: 10, text: '' });
    }
  };

  for (const b of blocks) {
    if (b.spacer) { pushLine(10, ''); continue; }
    if (b.heading) { pushLine(16, b.heading, 1); continue; }
    if (b.sub) { pushLine(12, b.sub, 0); continue; }
    for (const w of wrap(b.text || '', 92)) pushLine(10.5, w);
  }
  if (page.length) pages.push(page);

  const objects = [];
  const addObj = (body) => { objects.push(body); return objects.length; };

  const fontObjNum = 1;
  objects[0] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  const fontBoldObjNum = 2;
  objects[1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>';

  const pageObjNums = [];
  const contentObjNums = [];

  for (const p of pages) {
    let y = 780;
    let stream = 'BT\n';
    for (const line of p) {
      const font = line.fontSize >= 14 ? 'F2' : 'F1';
      stream += `/${font} ${line.fontSize} Tf\n`;
      stream += `1 0 0 1 56 ${y} Tm\n`;
      stream += `(${pdfEscape(line.text)}) Tj\n`;
      y -= line.fontSize + 6;
    }
    stream += 'ET';
    const contentObjNum = addObj(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    contentObjNums.push(contentObjNum);
  }

  for (let i = 0; i < pages.length; i++) {
    const pageObjNum = addObj(null); // placeholder, filled after we know the Pages obj number
    pageObjNums.push(pageObjNum);
  }

  const pagesObjNum = addObj(null);
  for (let i = 0; i < pageObjNums.length; i++) {
    objects[pageObjNums[i] - 1] =
      `<< /Type /Page /Parent ${pagesObjNum} 0 R /Resources << /Font << /F1 ${fontObjNum} 0 R /F2 ${fontBoldObjNum} 0 R >> >> /MediaBox [0 0 612 792] /Contents ${contentObjNums[i]} 0 R >>`;
  }
  objects[pagesObjNum - 1] = `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageObjNums.length} >>`;

  const catalogObjNum = addObj(`<< /Type /Catalog /Pages ${pagesObjNum} 0 R >>`);

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogObjNum} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return Buffer.from(pdf, 'latin1');
}

// --- content ------------------------------------------------------------

const FOOTER = [
  { spacer: true },
  { text: 'AdVoice Inc. | Graphic Design & Digital Marketing Agency | Ahmedabad, Gujarat' },
  { text: 'www.advoice.co.in' },
];

// Each entry: the topic slug it belongs to (null for the general/base one)
// and the exact FAQ question its file should be attached to.
export const docs = {
  'general-overview': {
    title: 'AdVoice Inc. — Portfolio Overview',
    topicSlug: null,
    description: 'A one-page overview PDF with a sample project from every service - logo design, brochures and catalogues, packaging, website design, digital marketing, and short video. Best for a lead who has not settled on a specific service yet, or wants a broad sense of the work before narrowing down. If they have already named a specific service, send that service\'s own portfolio file instead of this one.',
    blocks: [
      { heading: 'AdVoice Inc. — A Look At Our Work' },
      { text: 'Since 2012 we have delivered branding, print, digital, and marketing work across more than 30 industries, with particular depth in real estate, manufacturing, and pharma. Here is a quick look across our services - ask for a specific one and we will send more.' },
      { spacer: true },
      { sub: 'Logo & Brand Identity' },
      { text: 'Sample: Kalpavriksha Realty - a growth-oriented mark for a mid-size residential developer, delivered with full identity guidelines.' },
      { text: 'Sample: Ferrotech Industries - an industrial manufacturing identity built around precision and scale.' },
      { spacer: true },
      { sub: 'Brochures & Catalogues' },
      { text: 'Sample: Sundaram Pharma - a 24-page product catalogue for a pharmaceutical distributor, print-ready with die-line handling.' },
      { text: 'Sample: Greenfield Meadows - a premium real estate brochure covering amenities, floor plans, and location highlights.' },
      { spacer: true },
      { sub: 'Packaging' },
      { text: 'Sample: Aroha Wellness - packaging design for a small-batch skincare line, shelf-ready across three SKUs.' },
      { spacer: true },
      { sub: 'Website Design & Development' },
      { text: 'Sample: Meridian Interiors - a portfolio-style website for an interior design studio, built for mobile enquiries.' },
      { spacer: true },
      { sub: 'Digital Marketing' },
      { text: 'Sample: Vantage Realty - a Google My Business and PPC push that lifted local enquiry volume over a launch quarter.' },
      { spacer: true },
      { sub: 'Short Video' },
      { text: 'Sample: A 30-second reel for a boutique furniture brand, cut for Instagram and WhatsApp status.' },
      ...FOOTER,
    ],
  },
  'logo-design': {
    title: 'AdVoice Inc. — Logo & Brand Identity Portfolio',
    topicSlug: 'logo-design',
    description: 'A one-page PDF showing four recent logo and brand identity projects (Kalpavriksha Realty, Ferrotech Industries, Saffron Leaf Organics, Meridian Interiors), each with a short write-up of the brief and the direction taken. Send when a lead asks to see logo design samples, past work, or examples of the identity process.',
    blocks: [
      { heading: 'Logo & Brand Identity — Selected Work' },
      { text: 'A look at recent identity projects. Every mark below went through briefing, mind mapping, hand sketching, and three developed directions before final delivery.' },
      { spacer: true },
      { sub: '1. Kalpavriksha Realty' },
      { text: 'A residential real estate developer entering a competitive suburban market. The mark uses a rooted tree motif to signal long-term growth and stability, paired with a modern wordmark for broker-facing materials.' },
      { spacer: true },
      { sub: '2. Ferrotech Industries' },
      { text: 'An industrial manufacturing identity. The brief called for something that reads as precise and heavy-duty without feeling cold - the final mark combines a geometric gear form with warm greys.' },
      { spacer: true },
      { sub: '3. Saffron Leaf Organics' },
      { text: 'A packaged foods startup. The identity leans into a hand-drawn leaf mark and an earthy palette to signal an organic, small-batch positioning against larger commercial brands.' },
      { spacer: true },
      { sub: '4. Meridian Interiors' },
      { text: 'An interior design studio identity built around a minimal M monogram, designed to sit quietly on business cards, site boards, and Instagram alike.' },
      ...FOOTER,
    ],
  },
  'scientific-logo-design': {
    title: 'AdVoice Inc. — Scientific Logo Design Portfolio',
    topicSlug: 'scientific-logo-design',
    description: 'A one-page PDF with three examples of scientific/Vedic logo design work done through the consultation process with Maulik Dave (Suryodaya Finance, Vaidya Ayurveda Clinic, Nakshatra Jewellers). Only send this for scientific logo design questions specifically - use the standard logo design portfolio for ordinary logo requests instead.',
    blocks: [
      { heading: 'Scientific Logo Design — With Maulik Dave' },
      { text: 'A sample of identities developed through the scientific logo design process, where shape, colour, and symbolism are aligned to the business category and growth direction alongside standard design craft.' },
      { spacer: true },
      { sub: '1. Suryodaya Finance' },
      { text: 'A finance and lending business looking for a fresh growth phase. The mark and colour direction were developed after a consultation on the business category and current challenges, alongside the usual identity process.' },
      { spacer: true },
      { sub: '2. Vaidya Ayurveda Clinic' },
      { text: 'A traditional wellness clinic repositioning for a younger, urban audience while keeping its scientific and trust-driven roots intact in the mark.' },
      { spacer: true },
      { sub: '3. Nakshatra Jewellers' },
      { text: 'A family-run jewellery brand preparing for a second store launch. The identity work paired standard brand craft with the scientific logo design consultation for the growth-stage positioning.' },
      { spacer: true },
      { text: 'Interested in the process for your business? Share your name, business category, existing logo, and current biggest business challenge, and we will set up a short call with Maulik.' },
      ...FOOTER,
    ],
  },
  'brochure-catalogue-design': {
    title: 'AdVoice Inc. — Brochure & Catalogue Portfolio',
    topicSlug: 'brochure-catalogue-design',
    description: 'A one-page PDF with four brochure and catalogue design examples across real estate, pharma, manufacturing, and education. Send when a lead asks to see brochure or catalogue samples, or examples of print layout work.',
    blocks: [
      { heading: 'Brochure & Catalogue Design — Selected Work' },
      { text: 'A sample of print and digital brochure and catalogue projects across real estate, pharma, and manufacturing.' },
      { spacer: true },
      { sub: '1. Greenfield Meadows (Real Estate)' },
      { text: 'A 16-page project brochure covering site plan, floor plans, amenities, and location connectivity, designed for both print handout and WhatsApp sharing.' },
      { spacer: true },
      { sub: '2. Sundaram Pharma (Product Catalogue)' },
      { text: 'A 24-page distributor catalogue listing product lines with dosage information, organised by therapeutic category for field sales use.' },
      { spacer: true },
      { sub: '3. Ferrotech Industries (Corporate Brochure)' },
      { text: 'A corporate capability brochure covering manufacturing capacity, quality certifications, and client industries served.' },
      { spacer: true },
      { sub: '4. Aravali Public School (Institutional Brochure)' },
      { text: 'An admissions brochure covering programs, facilities, and student achievements, structured for parent-facing distribution.' },
      ...FOOTER,
    ],
  },
  'packaging-design': {
    title: 'AdVoice Inc. — Packaging Design Portfolio',
    topicSlug: 'packaging-design',
    description: 'A one-page PDF with three packaging design examples across skincare, packaged foods, and supplements. Send when a lead asks to see packaging design samples or past packaging projects.',
    blocks: [
      { heading: 'Packaging Design — Selected Work' },
      { text: 'A sample of packaging projects across personal care, food, and retail.' },
      { spacer: true },
      { sub: '1. Aroha Wellness (Skincare)' },
      { text: 'Shelf-ready packaging across a three-SKU skincare line, designed to read as premium and natural on a crowded retail shelf.' },
      { spacer: true },
      { sub: '2. Saffron Leaf Organics (Packaged Foods)' },
      { text: 'Pouch and box design for a small-batch organic foods brand, balancing shelf standout with clear ingredient and nutrition labelling.' },
      { spacer: true },
      { sub: '3. Nutrivalley (Health Supplements)' },
      { text: 'Bottle label and outer carton design for a supplements brand, built to work across pharmacy and e-commerce listings alike.' },
      ...FOOTER,
    ],
  },
  'website-design': {
    title: 'AdVoice Inc. — Website Design & Development Portfolio',
    topicSlug: 'website-design',
    description: 'A one-page PDF with three website design and development examples across interiors, real estate, and manufacturing. Send when a lead asks to see website samples or past web projects.',
    blocks: [
      { heading: 'Website Design & Development — Selected Work' },
      { text: 'A sample of websites designed and built for lead generation and portfolio presentation.' },
      { spacer: true },
      { sub: '1. Meridian Interiors' },
      { text: 'A portfolio-style site for an interior design studio, built mobile-first with a WhatsApp enquiry button on every page.' },
      { spacer: true },
      { sub: '2. Kalpavriksha Realty' },
      { text: 'A project microsite for a residential launch, covering floor plans, amenities, and a lead capture form connected to the sales team.' },
      { spacer: true },
      { sub: '3. Ferrotech Industries' },
      { text: 'A corporate site presenting manufacturing capabilities and certifications to B2B buyers, with a product enquiry workflow.' },
      ...FOOTER,
    ],
  },
  'digital-marketing': {
    title: 'AdVoice Inc. — Digital Marketing Portfolio',
    topicSlug: 'digital-marketing',
    description: 'A one-page PDF summarising three digital marketing projects covering PPC, Google My Business, and email marketing. Send when a lead asks about digital marketing results, examples, or past campaigns.',
    blocks: [
      { heading: 'Digital Marketing — Selected Work' },
      { text: 'A sample of PPC, Google My Business, and email marketing work.' },
      { spacer: true },
      { sub: '1. Vantage Realty (PPC + Google My Business)' },
      { text: 'A local search and PPC push around a project launch, focused on lifting enquiry volume from nearby searches during the launch quarter.' },
      { spacer: true },
      { sub: '2. Nutrivalley (Email Marketing)' },
      { text: 'A recurring email sequence to an existing customer list, focused on repeat purchase and new product announcements.' },
      { spacer: true },
      { sub: '3. Aroha Wellness (Google My Business)' },
      { text: 'Local listing optimisation and review management for a single-location skincare studio.' },
      ...FOOTER,
    ],
  },
  'video-creation': {
    title: 'AdVoice Inc. — Short Video Portfolio',
    topicSlug: 'video-creation',
    description: 'A one-page PDF with three short video project examples made for social media. Send when a lead asks to see video samples or past video work.',
    blocks: [
      { heading: 'Short-Form Video — Selected Work' },
      { text: 'A sample of short videos produced for social media and WhatsApp sharing.' },
      { spacer: true },
      { sub: '1. Meridian Interiors' },
      { text: 'A 30-second project walkthrough reel, cut for Instagram and WhatsApp status from on-site photography.' },
      { spacer: true },
      { sub: '2. Saffron Leaf Organics' },
      { text: 'A product story reel introducing the brand and its packaging, produced for a launch campaign.' },
      { spacer: true },
      { sub: '3. Kalpavriksha Realty' },
      { text: 'A short amenities highlight video for a residential project, used across paid social during the launch window.' },
      ...FOOTER,
    ],
  },
};
