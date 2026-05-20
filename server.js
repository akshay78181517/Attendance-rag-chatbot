const express = require('express');
const axios = require('axios');
const Groq = require('groq-sdk');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

let attendanceData = [];
let lastFetched = null;
let detectedCols = {}; // Will store the actual column names from the sheet

// Helper: Find the actual column name from the sheet (case-insensitive, flexible)
function findCol(row, candidates) {
  const keys = Object.keys(row);
  for (const candidate of candidates) {
    const match = keys.find(k => k.toLowerCase().trim() === candidate.toLowerCase().trim());
    if (match) return row[match] || 'N/A';
  }
  return 'N/A';
}

// Route: Fetch attendance from Google Sheets
app.post('/api/fetch-attendance', async (req, res) => {
  try {
    const sheetId = process.env.GOOGLE_SHEET_ID;
    const tabName = encodeURIComponent(process.env.SHEET_TAB);
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json&sheet=${tabName}`;

    const response = await axios.get(url);

    // Strip Google's JSON wrapper
    const jsonText = response.data.match(/google\.visualization\.Query\.setResponse\(([\s\S]*)\)/)[1];
    const json = JSON.parse(jsonText);

    const cols = json.table.cols.map(c => c.label);
    const rows = json.table.rows.map(row => {
      const obj = {};
      row.c.forEach((cell, i) => {
        obj[cols[i]] = cell ? cell.v : '';
      });
      return obj;
    });

    attendanceData = rows;
    lastFetched = new Date().toLocaleString();

    // DEBUG: Print actual column names so you can verify
    if (rows.length > 0) {
      console.log('✅ Actual column names from sheet:', Object.keys(rows[0]));
      console.log('📋 Sample row:', rows[0]);
    }

    res.json({
      success: true,
      count: rows.length,
      lastFetched,
      columns: rows.length > 0 ? Object.keys(rows[0]) : [],  // send column names to frontend too
      data: rows
    });
  } catch (err) {
    console.error('❌ Fetch error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Route: Chat with RAG using Groq
app.post('/api/chat', async (req, res) => {
  const { message, history } = req.body;

  if (!attendanceData.length) {
    return res.json({ reply: "Please fetch the attendance data first by clicking the 'Fetch Attendance' button." });
  }

  // Build context using flexible column finder — handles any naming variation
  const context = attendanceData.map(row => {
    const name       = findCol(row, ['Student Name', 'Name', 'student name', 'StudentName']);
    const id         = findCol(row, ['Student ID', 'ID', 'student id', 'StudentID', 'Roll No', 'Roll Number']);
    const course     = findCol(row, ['Course', 'course', 'Subject', 'Class']);
    let attendance = findCol(row, ['Attendance (%)', 'Attendance(%)', 'Attendance %', 'attendance', 'Attendance', 'Attendance(%)']);
    const email      = findCol(row, ['Email Address', 'Email', 'email']);
    // Convert decimal to percentage if stored as 0.78 instead of 78
    const attNum = parseFloat(attendance);
    if (!isNaN(attNum) && attNum > 0 && attNum <= 1) attendance = Math.round(attNum * 100);

    return `Student: ${name} | ID: ${id} | Course: ${course} | Attendance: ${attendance}% | Email: ${email}`;
  }).join('\n');

  const systemPrompt = `You are an attendance assistant. Answer questions about student attendance using ONLY the data below.
If a student is not found, say so clearly. Be helpful and concise.

ATTENDANCE DATA (fetched ${lastFetched}):
${context}`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...(history || []).slice(-10),
    { role: 'user', content: message }
  ];

  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 1024,
      messages
    });

    res.json({ reply: response.choices[0].message.content });
  } catch (err) {
    console.error('❌ Groq error:', err);
    res.status(500).json({ reply: 'Error contacting Groq API. Check your API key.' });
  }
});

app.listen(process.env.PORT, () => {
  console.log(`✅ Server running at http://localhost:${process.env.PORT}`);
});