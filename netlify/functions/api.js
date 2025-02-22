const axios = require('axios');
const express = require('express');
const serverless = require('serverless-http');
const cors = require('cors');
const pdfParse = require('pdf-parse');
const Tesseract = require('tesseract.js');
const mammoth = require('mammoth');
const fs = require('fs');
const path = require('path');
const { DOMParser } = require('xmldom'); // Required for docx parsing
const pdfExtract = require('pdf-text-extract'); // Fallback for OCR-based PDFs
const { PDFDocument } = require('pdf-lib');
const docx4js = require('docx4js');

const app = express();

// Logging function
const logToFile = (message) => {
    const logMessage = `${new Date().toISOString()} - ${message}\n`;
    fs.appendFileSync(path.join(__dirname, 'logs.txt'), logMessage);
};

// Override console.log to include logging to file
const originalConsoleLog = console.log;
console.log = (...args) => {
    originalConsoleLog(...args);
    logToFile(args.join(' '));
};

// Completely open CORS
app.use(cors({
    origin: '*',
    methods: '*',
    allowedHeaders: '*',
    credentials: true
}));

// No need for options handling as it's fully open
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', '*');
    res.header('Access-Control-Allow-Headers', '*');
    next();
});

app.use(express.json({ limit: '50mb' }));

// Update API key to use environment variable
const apiKey = process.env.MISTRAL_API_KEY;
const model = 'mistral-small-latest';
const systemPrompt = `
You are an AI assistant specialized in extracting structured information from CV texts. Analyze the provided CV text and extract all relevant details. Your output must be a valid JSON object with the following keys:
- **Name**: The full name of the candidate.
- **ContactInformation**: All contact details such as email, phone number, address, and any other available contact info.
- **Summary**: A brief professional summary or objective, if available.
- **Education**: Details of the candidate's educational background, including institution names, degrees, fields of study, and dates.
- **WorkExperience**: Job history including job titles, company names, durations, and descriptions of responsibilities and achievements.
- **Skills**: A list of technical and soft skills mentioned.
- **Certifications**: Any certifications or licenses obtained.
- **Languages**: Languages known and proficiency levels, if available.
- **Projects**: Notable projects or portfolio items described.
- **Achievements**: Any awards, honors, or special recognitions.
- **OtherDetails**: Any additional relevant information that does not fit in the above categories.
Important:
- If any field is missing from the CV text, assign it an empty string or an empty array (for list-type fields) as appropriate.
- Ensure the JSON is well-formatted and parsable.
- Handle variations in CV formats and naming conventions gracefully.
Your task is to parse and structure the CV text completely, ensuring no important details are omitted.
`;

// Middleware to log each request
app.use((req, res, next) => {
    logToFile(`Request: ${req.method} ${req.url} - Body: ${JSON.stringify(req.body)}`);
    next();
});

// Single endpoint to handle all CV processing
app.post('/api/analyze-cvs', async (req, res) => {
    const { documents } = req.body;
    
    if (!documents || !Array.isArray(documents)) {
        return res.status(400).json({ 
            error: 'Documents array is required in format: [{base64: "...", fileType: "pdf/docx/image"}]' 
        });
    }

    try {
        const processPromises = documents.map(async (doc, index) => {
            try {
                const { base64, fileType } = doc;
                
                if (!base64 || !fileType) {
                    return {
                        index,
                        status: 'error',
                        error: 'Missing base64 or fileType'
                    };
                }

                let extractedText;
                const buffer = Buffer.from(base64, 'base64');

                switch (fileType.toLowerCase()) {
                    case 'pdf':
                        extractedText = await extractTextFromPDF(buffer);
                        break;
                    case 'docx':
                        extractedText = await extractTextFromDocx(buffer);
                        break;
                    case 'png':
                    case 'jpg':
                    case 'jpeg':
                        const { data: { text } } = await Tesseract.recognize(buffer);
                        extractedText = text;
                        break;
                    default:
                        return { index, status: 'error', error: 'Unsupported file type' };
                }
                
                console.log('Extracted Text:', extractedText.substring(0, 200) + '...');

                const modifiedSystemPrompt = `${systemPrompt}
                IMPORTANT: Your response MUST be a valid JSON object. Do not include any explanatory text outside the JSON structure.`;

                const aiResponse = await axios.post('https://api.mistral.ai/v1/chat/completions', {
                    model: model,
                    messages: [
                        {
                            role: 'system',
                            content: modifiedSystemPrompt
                        },
                        {
                            role: 'user',
                            content: extractedText
                        }
                    ]
                }, {
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json'
                    }
                });

                const aiContent = aiResponse.data.choices[0].message.content;
                console.log('AI Response:', aiContent);

                let parsedResult;
                try {
                    let cleanContent = aiContent.trim();
                    if (cleanContent.startsWith('```json')) {
                        cleanContent = cleanContent.replace(/```json\n?/, '').replace(/```$/, '');
                    }
                    parsedResult = JSON.parse(cleanContent);
                } catch (parseError) {
                    console.error('Parse Error:', parseError);
                    return {
                        index,
                        status: 'error',
                        error: 'Failed to parse AI response',
                        rawContent: aiContent
                    };
                }

                return {
                    index,
                    status: 'success',
                    result: parsedResult
                };

            } catch (error) {
                console.error('Processing Error:', error);
                return {
                    index,
                    status: 'error',
                    error: error.message,
                    details: error.response?.data || 'No additional details'
                };
            }
        });

        const results = await Promise.all(processPromises);
        
        res.json({
            totalProcessed: results.length,
            results: results
        });

    } catch (error) {
        console.error('Main Error:', error);
        res.status(500).json({ 
            error: error.message,
            details: error.response?.data || 'No additional details'
        });
    }
});

// Simple health check endpoint
app.get('/api/health', async (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date()
    });
});

module.exports.handler = serverless(app);

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});


async function extractTextFromPDF(buffer) {
    try {
        const pdfDoc = await PDFDocument.load(buffer);
        const pages = await Promise.all(pdfDoc.getPages().map(async (page) => page.getTextContent()));
        return pages.map((page) => page.items.map((item) => item.str).join(' ')).join('\n');
    } catch (error) {
        console.error('Error with pdf-lib, trying OCR-based pdf-extract...', error);
        return new Promise((resolve, reject) => {
            pdfExtract(buffer, { layout: 'layout' }, (err, text) => {
                if (err) reject(err);
                resolve(text);
            });
        });
    }
}

async function extractTextFromDocx(buffer) {
    try {
        const doc = await docx4js.load(buffer);
        const xml = doc.content.mainDocument.xml;
        const docText = new DOMParser().parseFromString(xml, 'text/xml');
        return Array.from(docText.getElementsByTagName('w:t')).map((node) => node.textContent).join(' ');
    } catch (error) {
        console.error('Error extracting DOCX text:', error);
        return '';
    }
}
