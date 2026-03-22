const http = require('http');

const userId = '00000000-0000-0000-0000-000000000001'; // Demo User

async function testEndpoint(path) {
    console.log(`Testing ${path}...`);
    return new Promise((resolve) => {
        const options = {
            hostname: 'localhost',
            port: 3000,
            path: path,
            method: 'GET',
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                console.log(`Status: ${res.statusCode}`);
                try {
                    const json = JSON.parse(data);
                    console.log('Response Success:', json.success);
                    if (json.stats) console.log('Stats:', json.stats);
                    if (json.concepts) console.log('Concepts Count:', json.concepts.length);
                    resolve(json);
                } catch (e) {
                    console.log('Response (non-JSON):', data.substring(0, 100));
                    resolve(null);
                }
            });
        });

        req.on('error', (e) => {
            console.error(`Error: ${e.message}`);
            resolve(null);
        });
        req.end();
    });
}

async function runTests() {
    console.log('--- Study-Lens API Verification ---');
    await testEndpoint(`/api/user/stats?userId=${userId}`);
    const conceptsData = await testEndpoint(`/api/concepts?userId=${userId}`);

    if (conceptsData && conceptsData.concepts && conceptsData.concepts.length > 0) {
        const firstConcept = conceptsData.concepts[0];
        console.log(`Testing Learn API for concept: ${firstConcept.title}...`);
        const learnData = await testEndpoint(`/api/learn?conceptId=${firstConcept.id}&grade=10`);
        if (learnData && learnData.success && learnData.content) {
            console.log('Learn content generated successfully.');
            console.log('Title:', learnData.content.title);
            console.log('Section Count:', learnData.content.sections.length);
        }
    }

    console.log('--- Verification Complete ---');
}

runTests();
