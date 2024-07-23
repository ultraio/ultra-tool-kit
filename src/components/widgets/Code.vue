<template>
    <div>
        <template v-if="!props.editable">
            <div class="flex flex-col border border-neutral-700 rounded-lg">
                <CodeBlock
                    :code="props.code"
                    :highlightjs="true"
                    :lang="props.lang ? props.lang : 'json'"
                    theme="an-old-hope"
                />
            </div>
        </template>
        <template v-else>
            <template v-if="!isEditing">
                <Code :code="props.code" />
                <Button @click="startEditing">Edit</Button>
            </template>
            <template v-else>
                <div class="w-full h-[60vh]">
                    <vue-monaco-editor
                        v-model:value="displayedCode"
                        theme="vs-dark"
                        language="javascript"
                        :options="MONACO_EDITOR_OPTIONS"
                        @mount="handleEditorMount"
                    >
                        <template #failure>
                            <textarea
                                v-model="displayedCode"
                                class="w-full h-full p-2 border rounded bg-neutral-900 text-neutral-200"
                            ></textarea>
                        </template>
                    </vue-monaco-editor>
                </div>
                <!-- For whatever reason monaco editor adds a random interactive section of a fixed size, 
                    so to make buttons clickable, we increase their z-index, so they are on "top" of the editor -->
                <div class="flex justify-between mt-2 relative z-10">
                    <Button @click="cancelEditing">Cancel Changes</Button>
                    <Button @click="applyEdit">Apply Changes</Button>
                </div>
            </template>
        </template>

        <ErrorModal
            v-if="errorMessage"
            :title="'JSON Editor Error'"
            :errorMessage="errorMessage"
            @close="clearErrorMessage"
        ></ErrorModal>
    </div>
</template>

<script lang="ts" setup>
import { ref, onMounted, watch } from 'vue';

const props = defineProps<{
    code: string;
    lang?: string;
    editable?: boolean;
}>();

const MONACO_EDITOR_OPTIONS = {
    automaticLayout: true,
    formatOnType: true,
    formatOnPaste: true,
};

let displayedCode = ref<string>('');
let originalCode = ref<string>('');
let isEditing = ref<boolean>(false);
let errorMessage = ref('');
let monacoEditorLoaded = ref<boolean>(false);

const emit = defineEmits<{
    (e: 'apply-changes', text: string): void;
}>();

function startEditing() {
    originalCode.value = props.code;
    isEditing.value = true;
}

function cancelEditing() {
    displayedCode.value = originalCode.value;
    isEditing.value = false;
}

function applyEdit() {
    if (!props.lang || props.lang == 'json') {
        try {
            const parsed = JSON.parse(displayedCode.value);

            displayedCode.value = JSON.stringify(parsed, null, 2);
        } catch (error) {
            console.error('Invalid JSON format:', error);
            errorMessage.value = `Invalid JSON format: ${error.message}`;
            return;
        }
    }

    emit('apply-changes', displayedCode.value);
    isEditing.value = false;
}

const handleEditorMount = (editor) => {
    monacoEditorLoaded.value = true;
};

function clearErrorMessage() {
    errorMessage.value = '';
}

onMounted(() => {
    displayedCode.value = props.code;
});

// Watch for changes in props.code. Such change can occur when user deletes an action from the "Action Overview (Transaction.vue)" modal
watch(
    () => props.code,
    (currentValue, _oldValue) => {
        displayedCode.value = JSON.stringify(JSON.parse(currentValue), null, 2);
    }
);
</script>
