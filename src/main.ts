import { createApp } from 'vue';

import CodeBlock from 'vue3-code-block';
import { FontAwesomeIcon as FontAwesomeIconVue } from '@fortawesome/vue-fontawesome';

import './style.css';
import './icons';

import App from './App.vue';

import EndpointVue from './components/Endpoint.vue';
import InputVue from './components/widgets/Input.vue';
import SelectVue from './components/widgets/Select.vue';
import ButtonVue from './components/widgets/Button.vue';
import ModalVue from './components/widgets/Modal.vue';
import CodeVue from './components/widgets/Code.vue';
import ExpandVue from './components/widgets/Expand.vue';
import ActionDetailVue from './components/widgets/ActionDetail.vue';
import LinkVue from './components/widgets/Link.vue';
import AuthorizerFormVue from './components/widgets/AuthorizerForm.vue';
import SignatureFormVue from './components/widgets/SignatureForm.vue';
import LoadingSpinnerVue from './components/widgets/LoadingSpinner.vue';
import MetadataTableRowVue from './components/widgets/MetadataTableRow.vue';
import MetadataTableVue from './components/widgets/MetadataTable.vue';
import MediaVue from './components/widgets/Media.vue';
import MediaAreaVue from './components/widgets/MediaArea.vue';
import TabSelectionVue from './components/widgets/TabSelection.vue';
import LabelWithTooltipVue from './components/widgets/LabelWithTooltip.vue';
import ErrorModalVue from './components/widgets/ErrorModal.vue';

import ActionFormVue from './components/widgets/ActionForm/ActionForm.vue';
import ActionFormFieldVue from './components/widgets/ActionForm/ActionFormField.vue';
import ActionFormPrimitiveVue from './components/widgets/ActionForm/ActionFormPrimitive.vue';
import ActionFormArrayVue from './components/widgets/ActionForm/ActionFormArray.vue';
import ActionFormStructVue from './components/widgets/ActionForm/ActionFormStruct.vue';
import ActionFormExpandVue from './components/widgets/ActionForm/ActionFormExpand.vue';

import LoginVue from './components/Login.vue';
import UserOverlayVue from './components/UserOverlay.vue';
import TransactionVue from './components/Transaction.vue';
import AbiRenderVue from './components/AbiRender.vue';
import NavigationVue from './components/Navigation.vue';

import AnchorHelpVue from './components/help/AnchorHelp.vue';
import UltraWalletHelpVue from './components/help/UltraWalletHelp.vue';
import LedgerHelpVue from './components/help/LedgerHelp.vue';

import Vue3EasyDataTable from 'vue3-easy-data-table';
import 'vue3-easy-data-table/dist/style.css';

import { getRouter } from './router';

import { install as VueMonacoEditorPlugin } from '@guolao/vue-monaco-editor'

const app = createApp(App);

// Register Global Components
app.component('Endpoint', EndpointVue);
app.component('Login', LoginVue);
app.component('UserOverlay', UserOverlayVue);
app.component('Transaction', TransactionVue);
app.component('AbiRender', AbiRenderVue);
app.component('Navigation', NavigationVue);

// Register Utility Components
app.component('Modal', ModalVue);
app.component('Input', InputVue);
app.component('Select', SelectVue);
app.component('Button', ButtonVue);
app.component('Icon', FontAwesomeIconVue);
app.component('CodeBlock', CodeBlock);
app.component('Code', CodeVue);
app.component('Expand', ExpandVue);
app.component('ActionDetail', ActionDetailVue);
app.component('Link', LinkVue);
app.component('AuthorizerForm', AuthorizerFormVue);
app.component('SignatureForm', SignatureFormVue);
app.component('LoadingSpinner', LoadingSpinnerVue);
app.component('MetadataTableRow', MetadataTableRowVue);
app.component('MetadataTable', MetadataTableVue);
app.component('Media', MediaVue);
app.component('MediaArea', MediaAreaVue);
app.component('TabSelection', TabSelectionVue);
app.component('LabelWithTooltip', LabelWithTooltipVue);
app.component('ErrorModal', ErrorModalVue);

app.component('ActionForm', ActionFormVue);
app.component('ActionFormField', ActionFormFieldVue);
app.component('ActionFormPrimitive', ActionFormPrimitiveVue);
app.component('ActionFormArray', ActionFormArrayVue);
app.component('ActionFormStruct', ActionFormStructVue);
app.component('ActionFormExpand', ActionFormExpandVue);
app.component('EasyDataTable', Vue3EasyDataTable);

// Help
app.component('AnchorHelp', AnchorHelpVue);
app.component('UltraWalletHelp', UltraWalletHelpVue);
app.component('LedgerHelp', LedgerHelpVue);

// Router
app.use(getRouter());

app.use(VueMonacoEditorPlugin, {
    paths: {
        // The recommended CDN config
        vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.43.0/min/vs'
    },
})

// Mount application to `#app` ID
app.mount('#app');
