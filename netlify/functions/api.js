const axios = require('axios');
const express = require('express');
const serverless = require('serverless-http');
const app = express();

// Add middleware to parse JSON bodies
app.use(express.json({ limit: '50mb' }));

// Add required package for PDF parsing
const pdfParse = require('pdf-parse');

// Add required packages for PDF and image processing
const Tesseract = require('tesseract.js');

// Add required packages for file processing
const mammoth = require('mammoth'); // for DOCX files

const apiKey = '6V6226aySY3BqDtPqbsasNFSb3VnHhnf';
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

// Create POST endpoint to handle text analysis
// app.post('/analyze', async (req, res) => {
//     const { text } = req.body;
    
//     if (!text) {
//         return res.status(400).json({ error: 'Text is required' });
//     }

//     const data = {
//         model: model,
//         messages: [
//             {
//                 role: 'system',
//                 content: systemPrompt
//             },
//             {
//                 role: 'user',
//                 content: text
//             }
//         ]
//     };

//     try {
//         const response = await axios.post('https://api.mistral.ai/v1/chat/completions', data, {
//             headers: {
//                 'Authorization': `Bearer ${apiKey}`,
//                 'Content-Type': 'application/json'
//             }
//         });
        
//         res.json({ result: response.data.choices[0].message.content });
//     } catch (error) {
//         res.status(500).json({ 
//             error: error.response ? error.response.data : error.message 
//         });
//     }
// });

// // Create POST endpoint to handle document analysis (PDF or Image)
// app.post('/analyze-document', async (req, res) => {
//     const { base64Data, fileType } = req.body;
    
//     if (!base64Data) {
//         return res.status(400).json({ error: 'Base64 data is required' });
//     }
    
//     if (!fileType) {
//         return res.status(400).json({ error: 'File type is required (pdf/image)' });
//     }

//     try {
//         let extractedText;
        
//         if (fileType === 'pdf') {
//             // Handle PDF
//             const pdfBuffer = Buffer.from(base64Data, 'base64');
//             const pdfData = await pdfParse(pdfBuffer);
//             extractedText = pdfData.text;
//         } else if (fileType === 'image') {
//             // Handle Image
//             const imageBuffer = Buffer.from(base64Data, 'base64');
//             const { data: { text } } = await Tesseract.recognize(imageBuffer);
//             extractedText = text;
//         } else {
//             return res.status(400).json({ error: 'Invalid file type. Supported types: pdf, image' });
//         }
        
//         // Use the existing Mistral AI analysis logic
//         const data = {
//             model: model,
//             messages: [
//                 {
//                     role: 'system',
//                     content: systemPrompt
//                 },
//                 {
//                     role: 'user',
//                     content: extractedText
//                 }
//             ]
//         };

//         const response = await axios.post('https://api.mistral.ai/v1/chat/completions', data, {
//             headers: {
//                 'Authorization': `Bearer ${apiKey}`,
//                 'Content-Type': 'application/json'
//             }
//         });
        
//         res.json({ result: response.data.choices[0].message.content });
//     } catch (error) {
//         res.status(500).json({ 
//             error: error.response ? error.response.data : error.message 
//         });
//     }
// });

// Create POST endpoint for bulk CV upload and analysis
app.post('/analyze-cvs', async (req, res) => {
    const { documents } = req.body;
    
    if (!documents || !Array.isArray(documents)) {
        return res.status(400).json({ 
            error: 'Documents array is required in format: [{base64: "...", fileType: "pdf/docx/image"}]' 
        });
    }

    try {
        const results = [];
        
        // Process each document in parallel
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

                // Extract text based on file type
                switch(fileType.toLowerCase()) {
                    case 'pdf':
                        const pdfData = await pdfParse(buffer);
                        extractedText = pdfData.text;
                        break;
                        
                    case 'docx':
                        const { value } = await mammoth.extractRawText({ buffer });
                        extractedText = value;
                        break;
                        
                    case 'png':
                    case 'jpg':
                    case 'jpeg':
                        const { data: { text } } = await Tesseract.recognize(buffer);
                        extractedText = text;
                        break;
                        
                    default:
                        return {
                            index,
                            status: 'error',
                            error: 'Unsupported file type'
                        };
                }

                // Analyze extracted text with Mistral AI
                const data = {
                    model: model,
                    messages: [
                        {
                            role: 'system',
                            content: systemPrompt
                        },
                        {
                            role: 'user',
                            content: extractedText
                        }
                    ]
                };

                const response = await axios.post('https://api.mistral.ai/v1/chat/completions', data, {
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json'
                    }
                });

                return {
                    index,
                    status: 'success',
                    result: response.data.choices[0].message.content
                };

            } catch (error) {
                return {
                    index,
                    status: 'error',
                    error: error.message
                };
            }
        });

        // Wait for all documents to be processed
        const processedResults = await Promise.all(processPromises);
        
        res.json({
            totalProcessed: processedResults.length,
            results: processedResults
        });

    } catch (error) {
        res.status(500).json({ 
            error: error.message 
        });
    }
});

// Endpoint to process bulk CVs and return base64 data
app.post('/api/process-bulk-cvs', async (req, res) => {
    const { documents } = req.body;
    
    if (!documents || !Array.isArray(documents)) {
        return res.status(400).json({ 
            error: 'Documents array is required in format: [{base64: "...", fileType: "pdf/docx/image"}]' 
        });
    }

    try {
        // Process each document in parallel
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

                // Extract text based on file type
                switch(fileType.toLowerCase()) {
                    case 'pdf':
                        const pdfData = await pdfParse(buffer);
                        extractedText = pdfData.text;
                        break;
                        
                    case 'docx':
                        const { value } = await mammoth.extractRawText({ buffer });
                        extractedText = value;
                        break;
                        
                    case 'png':
                    case 'jpg':
                    case 'jpeg':
                        const { data: { text } } = await Tesseract.recognize(buffer);
                        extractedText = text;
                        break;
                        
                    default:
                        return {
                            index,
                            status: 'error',
                            error: 'Unsupported file type'
                        };
                }

                return {
                    index,
                    status: 'success',
                    extractedText
                };

            } catch (error) {
                return {
                    index,
                    status: 'error',
                    error: error.message
                };
            }
        });

        const processedResults = await Promise.all(processPromises);
        
        res.json({
            totalProcessed: processedResults.length,
            results: processedResults
        });

    } catch (error) {
        res.status(500).json({ 
            error: error.message 
        });
    }
});

// Endpoint to analyze bulk extracted texts
app.post('/api/analyze-bulk-texts', async (req, res) => {
    const { texts } = req.body;
    
    if (!texts || !Array.isArray(texts)) {
        return res.status(400).json({ 
            error: 'Texts array is required' 
        });
    }

    try {
        // Analyze each text in parallel
        const analysisPromises = texts.map(async (text, index) => {
            try {
                const data = {
                    model: model,
                    messages: [
                        {
                            role: 'system',
                            content: systemPrompt
                        },
                        {
                            role: 'user',
                            content: text
                        }
                    ]
                };

                const response = await axios.post('https://api.mistral.ai/v1/chat/completions', data, {
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json'
                    }
                });

                return {
                    index,
                    status: 'success',
                    result: JSON.parse(response.data.choices[0].message.content)
                };

            } catch (error) {
                return {
                    index,
                    status: 'error',
                    error: error.message
                };
            }
        });

        const analysisResults = await Promise.all(analysisPromises);
        
        res.json({
            totalAnalyzed: analysisResults.length,
            results: analysisResults
        });

    } catch (error) {
        res.status(500).json({ 
            error: error.message 
        });
    }
});

// Health check endpoint
app.get('/api/health', async (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date(),
        service: 'document-analyzer'
    });
});

module.exports.handler = serverless(app);

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});