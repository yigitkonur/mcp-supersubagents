import { AVAILABLE_MODELS, getModelsByTier, getRecommendedModel } from '../models.js';
export const getModelsTool = {
    name: 'get_available_models',
    description: 'Get list of all available AI models for Copilot CLI with descriptions and tiers',
    inputSchema: {
        type: 'object',
        properties: {
            tier: {
                type: 'string',
                enum: ['fast', 'standard', 'premium', 'all'],
                description: 'Filter models by tier: fast (quick/cheap), standard (balanced), premium (most capable), or all',
            },
        },
        required: [],
    },
};
export async function handleGetModels(args) {
    try {
        const params = args;
        const tier = params?.tier;
        let models = AVAILABLE_MODELS;
        if (tier && tier !== 'all') {
            models = getModelsByTier(tier);
        }
        const recommended = getRecommendedModel();
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({
                        success: true,
                        count: models.length,
                        recommended: recommended.id,
                        note: 'Some models require enablement. Run `copilot --model <model>` interactively first.',
                        models: models.map(m => ({
                            id: m.id,
                            name: m.name,
                            tier: m.tier,
                            description: m.description,
                            recommended: m.recommended || false,
                            requiresEnablement: m.requiresEnablement || false,
                        })),
                        tiers: {
                            fast: 'Quick responses, lower cost. Good for simple tasks.',
                            standard: 'Balanced performance and cost. Best for most coding tasks.',
                            premium: 'Most capable. Best for complex reasoning and large codebases.',
                        },
                    }, null, 2),
                },
            ],
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({
                        success: false,
                        error: message,
                    }, null, 2),
                },
            ],
        };
    }
}
//# sourceMappingURL=get-models.js.map