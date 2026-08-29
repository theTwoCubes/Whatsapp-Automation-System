import React, { useEffect, useState } from 'react';
import { api } from '../../api.js';
import Button from '../../components/ui/Button.jsx';
import { InputField } from '../../components/ui/Field.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import { useToast } from '../../components/ui/Toast.jsx';
import {
  AdminPage, Section, Card, CardHeader, CardBody,
  FormStack, FormActions, Divider, TabPills,
} from './Dashboard.jsx';

// ─── Business Profile ──────────────────────────────────────────
function BusinessProfile() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState({});
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
    try {
      await api.saveProfile({
        ...form,
        websites: form.websites ? form.websites.split(',').map((s) => s.trim()).filter(Boolean) : [],
      });
      toast.success('Business profile saved — changes go live on WhatsApp within a few minutes');
    } catch (e) { toast.error(e.message); }
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
    <Card>
      <CardHeader title="WhatsApp business profile" />
      <CardBody>
        <p className="text-sm text-gray-500 leading-relaxed mb-4">
          This information is shown to customers on WhatsApp when they view your business profile. Changes go directly to Meta.
        </p>
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
          <InputField label="Websites" helper="Enter one or more URLs separated by commas."
            placeholder="https://yourbusiness.com, https://instagram.com/yourbusiness"
            value={form.websites} onChange={(e) => setForm({ ...form, websites: e.target.value })} />
          <FormActions>
            <Button variant="primary" size="md" onClick={save}>Save profile</Button>
          </FormActions>
        </FormStack>
      </CardBody>
    </Card>
  );
}

// ─── AI Behaviour ──────────────────────────────────────────────
function AIBehaviour() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState({});
  const toast = useToast();

  useEffect(() => {
    api.getSettings().then((d) => { setData(d); setForm(d.settings || {}); }).catch(() => {});
  }, []);

  const save = async () => {
    try {
      await api.saveSettings({
        business_name:       form.business_name,
        business_about:      form.business_about,
        business_tone:       form.business_tone,
        fallback_message:    form.fallback_message,
        handoff_message:     form.handoff_message,
        attachment_message:  form.attachment_message,
        resume_minutes:      form.resume_minutes,
      });
      toast.success('Settings saved — the AI will use these in its next conversation');
    } catch (e) { toast.error(e.message); }
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
    <Card>
      <CardHeader title="How the AI talks and behaves" />
      <CardBody>
        <FormStack>
          <p className="text-xs font-semibold uppercase tracking-[0.06em] text-gray-500">Your business</p>
          <InputField label="Business name"
            helper="The name the AI uses to refer to your business in conversations."
            placeholder="Acme Studio"
            value={form.business_name || ''}
            onChange={(e) => setForm({ ...form, business_name: e.target.value })} />
          <InputField label="About the business" textarea
            helper="A brief description of what your business does. The AI uses this when a lead asks general questions."
            placeholder="We're a full-service creative agency specialising in brand identity, logo design, and marketing."
            value={form.business_about || ''}
            onChange={(e) => setForm({ ...form, business_about: e.target.value })} />
          <InputField label="Tone of voice"
            helper="How you want the AI to write. Keep it short — one or two words or a sentence."
            placeholder="Friendly and professional. Warm but concise. No slang."
            value={form.business_tone || ''}
            onChange={(e) => setForm({ ...form, business_tone: e.target.value })} />

          <Divider />
          <p className="text-xs font-semibold uppercase tracking-[0.06em] text-gray-500">Automatic messages</p>

          <InputField label="Fallback message" textarea
            helper="Sent when the AI has no relevant answer and does not hand off."
            placeholder="That's a great question — I'll need to check with the team and get back to you shortly."
            value={form.fallback_message || ''}
            onChange={(e) => setForm({ ...form, fallback_message: e.target.value })} />
          <InputField label="Handoff message" textarea
            helper="Sent when the AI passes a conversation to a team member."
            placeholder="A member of our team will be with you shortly. Thanks for your patience!"
            value={form.handoff_message || ''}
            onChange={(e) => setForm({ ...form, handoff_message: e.target.value })} />
          <InputField label="Attachment message" textarea
            helper="Sent when a customer sends a photo or file that the AI cannot process."
            placeholder="Thanks for sending that over! A team member will take a look and get back to you."
            value={form.attachment_message || ''}
            onChange={(e) => setForm({ ...form, attachment_message: e.target.value })} />

          <Divider />
          <p className="text-xs font-semibold uppercase tracking-[0.06em] text-gray-500">Automation</p>

          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-semibold text-gray-600 uppercase tracking-wide" style={{ letterSpacing: '0.06em' }}>
              Auto-resume after (minutes)
            </label>
            <input
              className="field-input"
              style={{ maxWidth: 160 }}
              type="number"
              min={0}
              placeholder="0 to disable"
              value={form.resume_minutes ?? ''}
              onChange={(e) => setForm({ ...form, resume_minutes: e.target.value })}
            />
            <p className="text-[11px] text-gray-400 leading-relaxed">
              If a conversation has been with a human agent for this many minutes without any reply, the AI takes back over automatically. Set to 0 to disable.
            </p>
          </div>

          <FormActions>
            <Button variant="primary" size="md" onClick={save}>Save settings</Button>
          </FormActions>
        </FormStack>
      </CardBody>
    </Card>
  );
}

// ─── Setup Page ────────────────────────────────────────────────
export default function Setup() {
  const [section, setSection] = useState('ai');

  return (
    <AdminPage
      title="Setup"
      subtitle="Configure how the AI talks, your WhatsApp business profile, and automation behaviour."
    >
      <TabPills
        tabs={[
          { key: 'ai',      label: 'AI behaviour' },
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
