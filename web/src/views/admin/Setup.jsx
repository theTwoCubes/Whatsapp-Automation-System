import React, { useEffect, useState } from 'react';
import { api } from '../../api.js';
import Button from '../../components/ui/Button.jsx';
import { InputField } from '../../components/ui/Field.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import { useToast } from '../../components/ui/Toast.jsx';
import {
  AdminPage, Section, Card, CardHeader, CardBody,
  FormStack, FormActions, TabPills,
} from './Dashboard.jsx';

// Business Profile
function BusinessProfile() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    api.getProfile().then((d) => {
      setData(d);
      const p = d.profile || {};
      setForm({
        about:       p.about       || '',
        description: p.description || '',
        email:       p.email       || '',
        address:     p.address     || '',
        vertical:    p.vertical    || '',
        websites:    (p.websites || []).join(', '),
      });
    }).catch(() => {});
  }, []);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await api.saveProfile({
        ...form,
        websites: form.websites ? form.websites.split(',').map((s) => s.trim()).filter(Boolean) : [],
      });
      toast.success('Business profile saved — changes go live on WhatsApp within a few minutes');
    } catch (e) { toast.error(e.message); }
    finally { setSaving(false); }
  };

  if (!data) return (
    <FormStack>
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i}>
          <Skeleton height={12} width="30%" style={{ marginBottom: 6 }} />
          <Skeleton height={36} />
        </div>
      ))}
    </FormStack>
  );

  return (
    <Section
      title="WhatsApp business profile"
      subtitle="Customers see this when they open your business profile inside WhatsApp. Changes go straight to Meta."
    >
      <Card>
        <CardBody>
        <FormStack>
          <InputField label="About" helper="A short tagline shown under your business name."
            placeholder="e.g. Helping brands stand out with great design."
            value={form.about} onChange={(e) => setForm({ ...form, about: e.target.value })} />
          <InputField label="Description" textarea
            helper="A fuller description of what your business does."
            placeholder="We're a creative studio specialising in brand identity, logo design, and digital marketing."
            value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <InputField label="Business email" placeholder="hello@yourbusiness.com"
            value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <InputField label="Address" placeholder="123 Main St, City, Country"
            value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          <InputField label="Websites" textarea rows={2}
            helper="Enter one or more URLs separated by commas."
            placeholder="https://yourbusiness.com, https://instagram.com/yourbusiness"
            value={form.websites} onChange={(e) => setForm({ ...form, websites: e.target.value })} />
          <FormActions>
            <Button variant="primary" size="sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save profile'}</Button>
          </FormActions>
        </FormStack>
      </CardBody>
      </Card>
    </Section>
  );
}

// AI Behaviour
function AIBehaviour() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    api.getSettings().then((d) => { setData(d); setForm(d.settings || {}); }).catch(() => {});
  }, []);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await api.saveSettings({
        business_name:       form.business_name,
        business_about:      form.business_about,
        business_tone:       form.business_tone,
        bot_name:            form.bot_name,
        fallback_message:    form.fallback_message,
        handoff_message:     form.handoff_message,
        attachment_message:  form.attachment_message,
        opt_out_message:     form.opt_out_message,
        resume_minutes:      form.resume_minutes,
        website_url:         form.website_url,
        contact_phone:       form.contact_phone,
        support_email:       form.support_email,
        instagram_url:       form.instagram_url,
      });
      toast.success('Settings saved — the AI will use these in its next conversation');
    } catch (e) { toast.error(e.message); }
    finally { setSaving(false); }
  };

  if (!data) return (
    <FormStack>
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i}>
          <Skeleton height={12} width="30%" style={{ marginBottom: 6 }} />
          <Skeleton height={36} />
        </div>
      ))}
    </FormStack>
  );

  const bind = (key) => ({
    value: form[key] ?? '',
    onChange: (e) => setForm({ ...form, [key]: e.target.value }),
  });

  return (
    <div className="flex flex-col gap-8">
      <Section
        title="How the AI describes your business"
        subtitle="The AI pulls from these when a lead asks who you are or what you do."
      >
        <Card>
          <CardBody>
          <FormStack>
            <InputField label="Business name"
              helper="The name the AI uses when it refers to you in a chat."
              placeholder="Acme Studio"
              {...bind('business_name')} />
            <InputField label="AI's name"
              helper="What the AI calls itself when it introduces itself to a new lead, once per chat."
              placeholder="Adi"
              {...bind('bot_name')} />
            <InputField label="About the business" textarea
              helper="A short description the AI can lean on for general questions."
              placeholder="We're a full-service creative agency specialising in brand identity, logo design, and marketing."
              {...bind('business_about')} />
            <InputField label="Tone of voice"
              helper="A line or two on how you want the AI to sound."
              placeholder="Friendly and professional. Warm but concise. No slang."
              {...bind('business_tone')} />
          </FormStack>
          </CardBody>
        </Card>
      </Section>

      <Section
        title="Contact details the AI can share"
        subtitle="Filled in here, so a lead asking for your website or a way to reach you gets a real answer instead of being sent to a person. Left blank, the AI simply won't offer it."
      >
        <Card>
          <CardBody>
          <FormStack>
            <InputField label="Website"
              placeholder="https://yourbusiness.com"
              {...bind('website_url')} />
            <InputField label="Phone number"
              placeholder="+91 98765 43210"
              {...bind('contact_phone')} />
            <InputField label="Email"
              placeholder="hello@yourbusiness.com"
              {...bind('support_email')} />
            <InputField label="Instagram"
              placeholder="https://instagram.com/yourbusiness"
              {...bind('instagram_url')} />
          </FormStack>
          </CardBody>
        </Card>
      </Section>

      <Section
        title="What the AI says at key moments"
        subtitle="Written for you in your voice, sent verbatim in these three situations. Edit the wording to match your brand."
      >
        <Card>
          <CardBody>
          <FormStack>
            <InputField label="When the AI is stuck" textarea
              helper="Used if the AI has nothing useful to say and is not handing off yet."
              placeholder="That's a great question — let me check with the team and get right back to you."
              {...bind('fallback_message')} />
            <InputField label="When passing the chat to a person" textarea
              helper="Sent right before a real teammate takes over."
              placeholder="Someone from our team will be with you shortly. Thanks for your patience!"
              {...bind('handoff_message')} />
            <InputField label="When a customer sends a file (currently unused)" textarea
              helper="The AI now looks at photos and documents itself and replies naturally, so this line is not sent anymore. Left here in case that ever needs to change."
              placeholder="Thanks for sending that over! Could you tell me a bit more about it in words too?"
              {...bind('attachment_message')} />
            <InputField label="When a customer asks to stop getting messages" textarea
              helper="Sent once, immediately, when a lead opts out. Follow ups stop for them right away - this just confirms it."
              placeholder="Understood, you won't receive further messages from us. Reply anytime if you need help."
              {...bind('opt_out_message')} />
          </FormStack>
          </CardBody>
        </Card>
      </Section>

      <Section
        title="When the AI takes back over"
        subtitle="If a teammate goes quiet on a chat, the AI can quietly resume so the lead is not left waiting."
      >
        <Card>
          <CardBody>
          <FormStack>
            <InputField label="Hand the chat back to the AI after"
              helper="Minutes of silence from your teammate. Set 0 to keep it with the team until they hand it back themselves."
              type="number"
              min={0}
              placeholder="0 to keep it with the team"
              style={{ maxWidth: 200 }}
              {...bind('resume_minutes')} />
          </FormStack>
        </CardBody>
      </Card>
      </Section>

      <div className="flex items-center justify-end">
        <Button variant="primary" size="sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</Button>
      </div>
    </div>
  );
}

// Setup Page
export default function Setup() {
  const [section, setSection] = useState('ai');

  return (
    <AdminPage
      title="Setup"
      subtitle="Configure the AI's rule, WhatsApp business profile, and when the AI should step in."
    >
      <TabPills
        tabs={[
          { key: 'ai',      label: 'AI voice & rules' },
          { key: 'profile', label: 'WhatsApp profile' },
        ]}
        active={section}
        onChange={setSection}
      />
      {section === 'ai'      && <AIBehaviour />}
      {section === 'profile' && <BusinessProfile />}
    </AdminPage>
  );
}
