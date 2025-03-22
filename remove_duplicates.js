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

// Filtra le domande che hanno esattamente 4 risposte
const filteredQuestions = uniqueQuestions.filter(q => 
    Array.isArray(q.answers) && q.answers.length === 4
);

// Salva il nuovo file JSON pulito
const outputFilePath = 'mock/cleaned_mock_questions.json';
fs.writeFileSync(outputFilePath, JSON.stringify(filteredQuestions, null, 4), 'utf8');

console.log(`Domande valide: ${filteredQuestions.length}`);
console.log(`File pulito salvato in: ${outputFilePath}`);
