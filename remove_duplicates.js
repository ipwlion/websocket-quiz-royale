const fs = require('fs');

// Carica il file JSON
const filePath = 'mock/cleaned_mock_questions.json';
const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

// Rimuove i duplicati basandosi sul testo della domanda
const uniqueQuestions = Object.values(
    data.reduce((acc, question) => {
        acc[question.question_text] = question;
        return acc;
    }, {})
);

// Salva il nuovo file JSON senza duplicati
const outputFilePath = 'mock/cleaned_mock_questions.json';
fs.writeFileSync(outputFilePath, JSON.stringify(uniqueQuestions, null, 4), 'utf8');
console.log(`dimensioni: ${uniqueQuestions.length}`);

console.log(`File pulito salvato in: ${outputFilePath}`);
