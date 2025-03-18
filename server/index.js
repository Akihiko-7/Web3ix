require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const nodemailer = require('nodemailer');

const app = express();
app.use(cors());
app.use(express.json());

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

app.post('/api/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  await supabase.from('verification_codes').delete().eq('email', email);

  console.log('Generated code:', { email, code, expiresAt });
  const { error: codeError } = await supabase
    .from('verification_codes')
    .insert({ email, code, expires_at: expiresAt });

  if (codeError) {
    console.error('Code insertion error:', codeError);
    return res.status(500).json({ error: codeError.message });
  }

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'Your Web3ix Verification Code',
      text: `Your 6-digit verification code is: ${code}\nThis code expires in 10 minutes.`,
    });
    console.log('Email sent successfully to:', email);
  } catch (emailError) {
    console.error('Email error:', emailError);
    return res.status(500).json({ error: 'Failed to send verification email' });
  }

  res.json({ message: 'Verification code sent. Please check your inbox.' });
});

app.post('/api/verify-code', async (req, res) => {
  const { email, password, code } = req.body;
  if (!email || !password || !code) {
    return res.status(400).json({ error: 'Email, password, and code are required' });
  }

  console.log('Verifying code:', { email, code });
  const { data: codeData, error: codeError } = await supabase
    .from('verification_codes')
    .select('*')
    .eq('email', email)
    .eq('code', code)
    .gte('expires_at', new Date().toISOString())
    .single();

  if (codeError || !codeData) {
    console.error('Code verification failed:', { codeError, codeData });
    return res.status(400).json({ error: 'Invalid or expired code' });
  }

  // Check if user exists and can sign in
  const { data: existingUser, error: signInError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (!signInError && existingUser) {
    await supabase.from('verification_codes').delete().eq('email', email).eq('code', code);
    return res.json({ user: existingUser.user });
  }

  // Attempt signup
  const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: null },
  });

  if (signUpError) {
    if (signUpError.message.includes('User already registered') || signUpError.message.includes('User not allowed')) {
      // User might be pending confirmation; try signing in again
      const { data: retrySignIn, error: retryError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (!retryError && retrySignIn) {
        await supabase.from('verification_codes').delete().eq('email', email).eq('code', code);
        return res.json({ user: retrySignIn.user });
      }
    }
    console.error('Signup error:', signUpError);
    return res.status(400).json({ error: signUpError.message });
  }

  // Confirm user
  const { error: updateError } = await supabase.auth.admin.updateUserById(
    signUpData.user.id,
    { email_confirmed_at: new Date().toISOString() }
  );

  if (updateError) {
    console.error('Update error:', updateError);
    return res.status(500).json({ error: updateError.message });
  }

  // Sign in
  const { data: signInData, error: loginError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (loginError) {
    console.error('Login error:', loginError);
    return res.status(500).json({ error: loginError.message });
  }

  await supabase.from('verification_codes').delete().eq('email', email).eq('code', code);

  res.json({ user: signInData.user });
});

// Keep Phantom and other endpoints unchanged
app.post('/api/phantom-signup', async (req, res) => {
  const { email, password, publicKey } = req.body;
  if (!email || !password || !publicKey) {
    return res.status(400).json({ error: 'Email, password, and public key are required' });
  }

  const { data: existingUser, error: existingSignInError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (!existingSignInError && existingUser) {
    return res.json({ user: existingUser.user });
  }

  const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: null,
      data: { provider: 'phantom', full_public_key: publicKey },
    },
  });

  if (signUpError) {
    console.log('Phantom signup error:', signUpError);
    return res.status(400).json({ error: signUpError.message });
  }

  const { error: updateError } = await supabase.auth.admin.updateUserById(
    signUpData.user.id,
    { email_confirmed_at: new Date().toISOString() }
  );

  if (updateError) {
    console.log('Phantom confirmation error:', updateError);
    return res.status(500).json({ error: updateError.message });
  }

  const { data: signInData, error: newSignInError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (newSignInError) {
    console.log('Phantom sign-in error:', newSignInError);
    return res.status(500).json({ error: newSignInError.message });
  }

  res.json({ user: signInData.user });
});

app.get('/api/posts', async (req, res) => {
  const { data, error } = await supabase
    .from('posts')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/api/videos', async (req, res) => {
  const { data, error } = await supabase
    .from('posts')
    .select('*')
    .eq('is_video', true)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));