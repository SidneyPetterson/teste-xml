require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const xml2js = require('xml2js');
const he = require('he');

const app = express();
const port = process.env.PORT || 3000;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

function sanitizeForXML(str) {
    if (!str) return '';
    return he.encode(str.toString(), { useNamedReferences: true })
        .replace(/'/g, '')
        .replace(/"/g, '"');
}

function formatToXMLTV(date) {
    if (!date || isNaN(new Date(date))) return '';
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const seconds = String(d.getSeconds()).padStart(2, '0');
    return `${year}${month}${day}${hours}${minutes}${seconds} -0300`;
}

async function testSupabaseConnection() {
    console.log('Testando conexão com Supabase...');
    try {
        const { data, error } = await supabase.from('canais').select('canal_id').limit(1);
        if (error) throw error;
        console.log('Conexão com Supabase bem-sucedida');
    } catch (error) {
        console.error('Erro ao testar conexão:', error.message);
        throw error;
    }
}

async function getEPG(useMockData = false) {
    try {
        let canais, programacoes, logotipos;

        // Intervalo: dia atual até +6 dias
        const now = new Date();
        const startDate = now.toISOString().split('T')[0]; // Ex.: 2025-06-14
        const endDate = new Date(now.getTime() + 6 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] + ' 23:59:59'; // Ex.: 2025-06-20
        console.log('Intervalo de consulta:', { startDate, endDate });

        if (useMockData) {
            canais = [{ canal_id: 'mock.canal', nome: 'Canal Mock' }];
            logotipos = [];
            programacoes = [];
        } else {
            console.log('Consultando tabela "canais"...');
            const { data: canaisData, error: canaisError } = await supabase
                .from('canais')
                .select('canal_id, nome');
            if (canaisError) throw canaisError;
            canais = canaisData;
            console.log(`Canais obtidos: ${canais.length}`);

            console.log('Consultando tabela "logotipo"...');
            const { data: logotiposData, error: logotiposError } = await supabase
                .from('logotipo')
                .select('canal_id, links');
            if (logotiposError) throw logotiposError;
            logotipos = logotiposData;

            console.log('Consultando tabela "programacoes" com paginação...');
            let allProgramacoes = [];
            let offset = 0;
            const pageSize = 1000;
            while (true) {
                console.log(`Consultando programações, offset: ${offset}`);
                const { data, error } = await supabase
                    .from('programacoes')
                    .select('canal_id, titulo, inicio, fim, descricao')
                    .gte('inicio', startDate)
                    .lte('inicio', endDate)
                    .range(offset, offset + pageSize - 1);
                if (error) throw error;
                allProgramacoes = allProgramacoes.concat(data);
                console.log(`Programações obtidas nesta página: ${data.length}`);
                if (data.length < pageSize) break;
                offset += pageSize;
            }
            console.log('Total de programações obtidas:', allProgramacoes.length);
            programacoes = allProgramacoes;

            // Log da distribuição por canal
            const programCountByChannel = programacoes.reduce((acc, prog) => {
                acc[prog.canal_id] = (acc[prog.canal_id] || 0) + 1;
                return acc;
            }, {});
            console.log('Distribuição de programações por canal:', programCountByChannel);
        }

        const epgJson = {
            tv: {
                $: {
                    'source-info-name': 'SIDROID XMLTV API v2.0',
                    'source-info-url': 'https://www.guiadetv.com'
                },
                channel: [],
                programme: []
            }
        };

        canais.forEach(canal => {
            const logotipo = logotipos.find(logo => logo.canal_id === canal.canal_id);
            const channelObj = {
                $: { id: sanitizeForXML(canal.canal_id) },
                'display-name': [{ $: { lang: 'pt' }, _: sanitizeForXML(canal.nome || 'Nome não definido') }],
                icon: logotipo && logotipo.links ? [{ $: { src: sanitizeForXML(logotipo.links) } }] : []
            };
            epgJson.tv.channel.push(channelObj);

            const filteredPrograms = programacoes
                .filter(prog => prog.canal_id === canal.canal_id)
                .sort((a, b) => new Date(a.inicio) - new Date(b.inicio));

            filteredPrograms.forEach(programacao => {
                try {
                    const startDate = new Date(programacao.inicio);
                    const endDate = new Date(programacao.fim);

                    if (isNaN(startDate) || isNaN(endDate)) {
                        console.warn(`Programação ignorada por datas inválidas:`, programacao);
                        return;
                    }

                    const programa = {
                        $: {
                            channel: sanitizeForXML(canal.canal_id),
                            start: formatToXMLTV(startDate),
                            stop: formatToXMLTV(endDate)
                        },
                        title: [{ $: { lang: 'pt' }, _: sanitizeForXML(programacao.titulo || 'Título não definido') }],
                        desc: programacao.descricao && programacao.descricao !== 'Sem descrição' ? [{ $: { lang: 'pt' }, _: sanitizeForXML(programacao.descricao) }] : []
                    };

                    epgJson.tv.programme.push(programa);
                } catch (error) {
                    console.error('Erro ao processar programação:', { canal_id: programacao.canal_id, error: error.message });
                }
            });
        });

        const builder = new xml2js.Builder({
            rootName: 'tv',
            xmldec: { version: '1.0', encoding: 'UTF-8' }
        });

        const xml = builder.buildObject(epgJson);
        return xml;
    } catch (error) {
        console.error('Erro ao obter dados:', error.message);
        throw error;
    }
}

app.get('/epg', async (req, res) => {
    try {
        const useMockData = process.env.USE_MOCK_DATA === 'true';
        const xml = await getEPG(useMockData);
        res.set('Content-Type', 'application/xml');
        res.send(xml);
    } catch (error) {
        res.status(500).send('Erro ao gerar EPG');
    }
});

app.get('/debug', async (req, res) => {
    try {
        const useMockData = process.env.USE_MOCK_DATA === 'true';
        let canais, programacoes, logotipos;

        const now = new Date();
        const startDate = now.toISOString().split('T')[0];
        const endDate = new Date(now.getTime() + 6 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] + ' 23:59:59';

        if (useMockData) {
            canais = [{ canal_id: 'mock.canal', nome: 'Canal Mock' }];
            logotipos = [];
            programacoes = [];
        } else {
            const { data: canaisData, error: canaisError } = await supabase.from('canais').select('canal_id, nome');
            if (canaisError) throw canaisError;
            canais = canaisData;

            const { data: logotiposData, error: logotiposError } = await supabase.from('logotipo').select('canal_id, links');
            if (logotiposError) throw logotiposError;
            logotipos = logotiposData;

            let allProgramacoes = [];
            let offset = 0;
            const pageSize = 1000;
            while (true) {
                const { data, error } = await supabase
                    .from('programacoes')
                    .select('canal_id, titulo, inicio, fim, descricao')
                    .gte('inicio', startDate)
                    .lte('inicio', endDate)
                    .range(offset, offset + pageSize - 1);
                if (error) throw error;
                allProgramacoes = allProgramacoes.concat(data);
                if (data.length < pageSize) break;
                offset += pageSize;
            }
            programacoes = allProgramacoes;
        }

        const programCountByChannel = programacoes.reduce((acc, prog) => {
            acc[prog.canal_id] = (acc[prog.canal_id] || 0) + 1;
            return acc;
        }, {});

        res.json({
            status: 'success',
            data: {
                canais,
                programacoes,
                logotipos,
                total_canais: canais.length,
                total_programacoes: programacoes.length,
                program_count_by_channel: programCountByChannel
            }
        });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

app.listen(port, async () => {
    console.log(`API rodando em http://localhost:${port}`);
    await testSupabaseConnection();
});